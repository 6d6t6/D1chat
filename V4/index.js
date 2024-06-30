export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ipAddress = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || request.headers.get("remote_addr") || request.headers.get("ip");
    
    if (request.method === "GET" && url.pathname === "/send") {
      // Check if IP is banned
      if (await isIPBanned(ipAddress, env)) {
        return new Response("Your IP address is banned from sending messages", { status: 403 });
      }

      // Rate limiting for IP
      const rateLimitExceeded = await checkIPRateLimit(ipAddress, env);
      if (rateLimitExceeded) {
        return new Response("Rate limit exceeded for your IP address", { status: 429 });
      }

      const user = url.searchParams.get("u");
      const message = url.searchParams.get("m");

      if (!user || !message) {
        return new Response("Missing user or message", { status: 400 });
      }

      const now = Date.now();
      const userKey = `user_${user}`;
      const ipKey = `ip_${ipAddress}`;

      // Get user data from KV
      const userData = await env.CHAT_KV.get(userKey, { type: 'json' }) || { count: 0, lastMessageTime: 0, suspendedUntil: 0 };
      const ipData = await env.CHAT_KV.get(ipKey, { type: 'json' }) || { count: 0, lastMessageTime: 0, suspendedUntil: 0 };

      // Update message count and timestamp for user
      if (now - userData.lastMessageTime < 60000) { // 1 minute window
        userData.count += 1;
      } else {
        userData.count = 1;
      }
      userData.lastMessageTime = now;

      // Update message count and timestamp for IP
      if (now - ipData.lastMessageTime < 60000) { // 1 minute window
        ipData.count += 1;
      } else {
        ipData.count = 1;
      }
      ipData.lastMessageTime = now;

      // Check if message limit is exceeded for user or IP
      if (userData.count > 5 || ipData.count > 5) { // More than 5 messages in a minute
        const suspensionTime = now + (60000 * Math.max(userData.count, ipData.count));
        userData.suspendedUntil = suspensionTime; // Suspend user
        ipData.suspendedUntil = suspensionTime; // Suspend IP
        await Promise.all([
          env.CHAT_KV.put(userKey, JSON.stringify(userData)),
          env.CHAT_KV.put(ipKey, JSON.stringify(ipData))
        ]);
        return new Response(`You are suspended from sending messages for ${Math.max(userData.count, ipData.count)} minute(s)`, { status: 429 });
      }

      // Store updated user and IP data in KV
      await Promise.all([
        env.CHAT_KV.put(userKey, JSON.stringify(userData)),
        env.CHAT_KV.put(ipKey, JSON.stringify(ipData))
      ]);

      // Store the message in the database
      await env.DB.prepare("INSERT INTO messages (user, message) VALUES (?, ?)")
                  .bind(user, message)
                  .run();
      return new Response("Message sent", { status: 200 });

    } else if (request.method === "GET" && url.pathname === "/messages") {
      const { results } = await env.DB.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 100").all();
      return new Response(JSON.stringify(results), { status: 200 });

    } else if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderHTML(), {
        headers: { "Content-Type": "text/html" },
      });

    } else {
      return new Response("Not Found", { status: 404 });
    }
  }
};

// Function to check if IP is banned
async function isIPBanned(ip, env) {
  const bannedIPs = await env.CHAT_KV.get("bannedIPs", { type: 'json' }) || [];
  return bannedIPs.includes(ip);
}

// Function to check IP rate limit
async function checkIPRateLimit(ip, env) {
  const ipKey = `ip_${ip}`;
  const ipData = await env.CHAT_KV.get(ipKey, { type: 'json' }) || { count: 0, lastMessageTime: 0 };
  const now = Date.now();

  // Reset count if last message time was more than 1 minute ago
  if (now - ipData.lastMessageTime > 60000) {
    ipData.count = 0;
  }

  // Increment message count and update last message time
  ipData.count++;
  ipData.lastMessageTime = now;

  // Store updated IP data in KV
  await env.CHAT_KV.put(ipKey, JSON.stringify(ipData));

  // Check if rate limit exceeded
  return ipData.count > 5; // More than 5 messages in a minute
}

function renderHTML() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Chat Application</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        #messages { border: 1px solid #ccc; padding: 10px; height: 300px; overflow-y: scroll; margin-bottom: 10px; }
        #form { display: flex; }
        #form input[type="text"] { flex: 1; padding: 10px; margin-right: 10px; }
        #form button { padding: 10px; }
      </style>
    </head>
    <body>
      <h1>Chat Application</h1>
      <div id="messages"></div>
      <form id="form">
        <input type="text" id="username" placeholder="Username" required>
        <input type="text" id="message" placeholder="Message" required>
        <button type="submit">Send</button>
      </form>
      <script>
        async function fetchMessages() {
          const response = await fetch('/messages');
          const messages = await response.json();
          const messagesDiv = document.getElementById('messages');
          messagesDiv.innerHTML = messages.map(msg => 
            \`<p><strong>\${msg.user}:</strong> \${msg.message} <small>(\${new Date(msg.timestamp).toLocaleTimeString()})</small></p>\`
          ).join('');
        }

        document.getElementById('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const username = document.getElementById('username').value;
          const message = document.getElementById('message').value;
          const response = await fetch(\`/send?u=\${username}&m=\${encodeURIComponent(message)}\`);
          const responseText = await response.text();
          if (response.status === 429 || response.status === 403) {
            alert(responseText);
          }
          document.getElementById('message').value = '';
          fetchMessages();
        });

        fetchMessages();
        setInterval(fetchMessages, 5000);
      </script>
    </body>
    </html>
  `;
}
