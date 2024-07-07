export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ipAddress =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      request.headers.get("x-forwarded-for") ||
      request.headers.get("remote_addr") ||
      request.headers.get("ip");

    if (request.method === "GET" && url.pathname === "/send") {
      // Check if IP is banned
      if (await isIPBanned(ipAddress, env)) {
        return new Response("Your IP address is banned from sending messages", { status: 403 });
      }

      // Rate limiting for IP
      const rateLimitExceeded = await checkIPRateLimit(ipAddress, env);
      if (rateLimitExceeded) {
        const suspensionTime = await getSuspensionTime(ipAddress, env);
        return new Response(`Rate limit exceeded for your IP address. Please check back in ${formatTimeUntil(suspensionTime)}`, { status: 429 });
      }

      const user = url.searchParams.get("u");
      const message = url.searchParams.get("m");

      if (!user || !message) {
        return new Response("Missing user or message", { status: 400 });
      }

      const now = Date.now();
      const key = `data_${ipAddress}`;
      let data = await env.CHAT_KV.get(key, { type: 'json' }) || { users: {}, count: 0, lastMessageTime: 0, suspendedUntil: 0 };

      // Update message count and timestamp for user and IP
      if (!data.users[user]) {
        data.users[user] = { count: 0, lastMessageTime: 0, suspendedUntil: 0 };
      }

      const userData = data.users[user];
      if (now - userData.lastMessageTime < 15000) { // 15 sec window
        userData.count += 1;
      } else {
        userData.count = 1;
      }
      userData.lastMessageTime = now;

      if (now - data.lastMessageTime < 15000) { // 15 sec window
        data.count += 1;
      } else {
        data.count = 1;
      }
      data.lastMessageTime = now;

      // Check if message limit is exceeded for user or IP
      if (userData.count > 5 || data.count > 5) { // More than 5 messages in short amount of time
        const suspensionTime = now + (15000 * Math.max(userData.count, data.count));
        userData.suspendedUntil = suspensionTime; // Suspend user
        data.suspendedUntil = suspensionTime; // Suspend IP
        await env.CHAT_KV.put(key, JSON.stringify(data));
        return new Response(`You are suspended from sending messages for ${Math.max(userData.count, data.count)} minute(s). Please check back in ${formatTimeUntil(suspensionTime)}`, { status: 429 });
      }

      // Store updated data in KV
      await env.CHAT_KV.put(key, JSON.stringify(data));

      // Store the message in the database
      await env.DB.prepare("INSERT INTO messages (user, message, timestamp) VALUES (?, ?, ?)")
                  .bind(user, message, now)
                  .run();
      return new Response("Message sent", { status: 200 });

    } else if (request.method === "GET" && url.pathname === "/messages") {
      const username = url.searchParams.get("u");
      const key = `data_${ipAddress}`;
      const data = await env.CHAT_KV.get(key, { type: 'json' });

      if (!data || !data.users[username]) {
        return new Response("User not found", { status: 404 });
      }

      const joinTime = data.users[username].joinTime;
      let query;
      let params;

      // Check if last fetched message ID is available
      const lastFetchedId = url.searchParams.get("lastId");

      if (lastFetchedId) {
        // Fetch messages newer than the last fetched ID and after the user's join time
        query = "SELECT * FROM messages WHERE timestamp > ? AND id > ? ORDER BY timestamp ASC LIMIT 100";
        params = [joinTime, lastFetchedId];
      } else {
        // Fetch messages newer than the user's join time
        query = "SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 100";
        params = [joinTime];
      }

      const { results } = await env.DB.prepare(query).bind(...params).all();

      return new Response(JSON.stringify(results), { status: 200 });

    } else if (request.method === "GET" && url.pathname === "/join") {
      const username = url.searchParams.get("u");

      if (!username) {
        return new Response("Missing username", { status: 400 });
      }

      const now = Date.now();
      const key = `data_${ipAddress}`;
      let data = await env.CHAT_KV.get(key, { type: 'json' }) || { users: {} };

      if (!data.users[username]) {
        data.users[username] = { joinTime: now };
      } else {
        // Update join time if user already exists
        data.users[username].joinTime = now;
      }

      await env.CHAT_KV.put(key, JSON.stringify(data));

      // Send system message
      const joinMessage = `[${username}] has joined the chat`;

      await env.DB.prepare("INSERT INTO messages (user, message, timestamp) VALUES (?, ?, ?)")
                  .bind("system", joinMessage, now)
                  .run();

      // Return the join message as a response
      return new Response(joinMessage, { status: 200 });

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
  const bannedIPs = await env.CHAT_KV.get("bannedIPs", { type: 'json' }) || []; // <-- Banned IP Addresses go in the square brackets
  return bannedIPs.includes(ip);
}

// Function to check IP rate limit
async function checkIPRateLimit(ip, env) {
  const key = `data_${ip}`;
  const data = await env.CHAT_KV.get(key, { type: 'json' }) || { count: 0, lastMessageTime: 0 };
  const now = Date.now();

  // Reset count if last message time was more than 15 sec ago
  if (now - data.lastMessageTime > 15000) {
    data.count = 0;
  }

  // Increment message count and update last message time
  data.count++;
  data.lastMessageTime = now;

  // Store updated data in KV
  await env.CHAT_KV.put(key, JSON.stringify(data));

  // Check if rate limit exceeded
  return data.count > 5; // More than 5 messages in a minute
}

// Function to get suspension time
async function getSuspensionTime(ip, env) {
  const key = `data_${ip}`;
  const data = await env.CHAT_KV.get(key, { type: 'json' }) || { suspendedUntil: 0 };
  return data.suspendedUntil || 0;
}

// Function to format time until a future timestamp
function formatTimeUntil(timestamp) {
  const now = Date.now();
  const timeRemaining = timestamp - now;

  if (timeRemaining <= 0) {
    return "now";
  }

  const seconds = Math.floor(timeRemaining / 1000) % 60;
  const minutes = Math.floor(timeRemaining / (1000 * 60)) % 60;
  const hours = Math.floor(timeRemaining / (1000 * 60 * 60)) % 24;

  if (hours > 0) {
    return `${hours} hour(s) and ${minutes} minute(s)`;
  } else if (minutes > 0) {
    return `${minutes} minute(s) and ${seconds} second(s)`;
  } else {
    return `${seconds} second(s)`;
  }
}

function renderHTML() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Chat</title>
      <script src="https://equinox.pages.dev/cdn/equinox-optimizer.js"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Inter+Tight:ital,wght@0,100..900;1,100..900&family=Inter:wght@100..900&family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>
        body { font-family: 'DM Mono', monospace; font-size: 16px; color: #fff; background: #080808; padding: 0; margin: 0; }
        #messages { border: none; border-radius: 8px; background: #161616; padding: 0; height: calc(100vh - 72px); overflow-y: scroll; margin: 8px; align-content: end; }
        #messages>p { padding: 4px 16px; margin: 0 !important; }
        #messages>p:first-child { margin-top: 12px !important; }
        #messages>p:last-child { margin-bottom: 12px !important; }
        input[type="text"], button { outline: none; outline-offset: -1px; }
        input[type="text"]:focus { outline: 1px solid #646464; }
        #form { display: flex; bottom: 0; position: fixed; width: 100%; }
        #form input[type="text"] { flex: 1; padding: 0 16px; height: 48px; font-family: 'DM Mono', monospace; font-size: 16px; line-height: 1; color: #fff; background: #161616; border: none; border-radius: 8px; line-height: 1; margin: 8px 0 8px 8px; }
        #form button { padding: 0 16px; font-family: 'DM Mono', monospace; font-size: 16px; line-height: 1; color: #000; background: #ec8dd2; border: none; border-radius: 8px; margin: 8px; font-weight: bold; }
        #form button:focus, button#joinChatButton:focus { outline: 1px solid #ec8dd2; background: #ec8dd220; color: #ec8dd2; }
        #usernameModal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #080808; display: flex; align-items: center; justify-content: center; }
        #usernameModalContent { background: #161616; border-radius: 8px; text-align: left; max-width: 318px !important; padding: 12px 0 0; border: 1px solid #202020; }
        #usernameModalContent h2 { margin: 0; padding: 8px 16px; }
        #usernameModalContent p { padding: 8px 16px; margin: 0; }
        #usernameModalContent blockquote { margin: 0; padding: 8px 16px; font-size: 12px; font-style: italic; font-weight: 100; }
        #usernameModal input[type="text"] { padding: 0 16px; margin: 16px; width: 168px; line-height: 1; auto; height: 48px; font-family: 'DM Mono', monospace; font-size: 16px; color: #fff; background: #202020; border: none; border-radius: 8px; }
        div#joinChatContent { display: flex; align-items: center; }
        button#joinChatButton { height: 48px; border: none; border-radius: 8px; font-family: 'DM Mono', monospace; font-size: 16px; color: #000; line-height: 1; background: #ec8dd2; padding: 0 16px; font-weight: bold; margin: 16px 16px 16px 0; }
        /* SCROLLBAR */
        ::-webkit-scrollbar { width: 8px; height: 8px; background: transparent; }
        ::-webkit-scrollbar-track { border-radius: 8px; margin: 8px; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 10px; border: 0px solid #080808; }
        ::-webkit-scrollbar-thumb:hover { background: #333; }
        ::-webkit-scrollbar-corner { background: transparent; }
      </style>
    </head>
    <body>
      <div id="messages"></div>
      <form id="form">
        <input type="text" id="message" placeholder="Message" required autocomplete="off">
        <button type="submit">Send</button>
      </form>
      <div id="usernameModal">
        <div id="usernameModalContent">
          <h2>Welcome</h2>
          <p>Do not share personal information.</p>
          <blockquote>"If you can't say something nice, don't say nothing at all."<br>— Thumper</blockquote>
          <div id="joinChatContent">
            <input type="text" id="usernameInput" placeholder="Username" required autocomplete="off">
            <button id="joinChatButton">Join</button>
          </div>
        </div>
      </div>
      <script>
        let username;
        
        document.getElementById('joinChatButton').addEventListener('click', async () => {
          username = document.getElementById('usernameInput').value;
          if (username) {
            const response = await fetch(\`/join?u=\${username}\`);
            const responseText = await response.text();
            
            // Display join message to the user who joined
            const messagesDiv = document.getElementById('messages');
            const messageElement = document.createElement('p');
            messageElement.innerHTML = \`<strong>System </strong><small>(\${new Date().toLocaleTimeString()})</small><br> \${responseText}\`;
            messagesDiv.appendChild(messageElement);

            document.getElementById('usernameModal').style.display = 'none';
            localStorage.setItem('username', username);
            fetchMessages();
            setInterval(fetchMessages, 5000);
          }
        });

        async function fetchMessages() {
          const response = await fetch(\`/messages?u=\${username}\`);
          const messages = await response.json();
          
          if (messages.length > 0) {
            const messagesDiv = document.getElementById('messages');
            messagesDiv.innerHTML = ''; // Clear previous messages
            messages.forEach(msg => {
              const messageElement = document.createElement('p');
              messageElement.innerHTML = \`<strong>\${msg.user} </strong><small>(\${new Date(msg.timestamp).toLocaleTimeString()})</small><br> \${msg.message}\`;
              messagesDiv.appendChild(messageElement);
            });

            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }
        }

        document.getElementById('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const message = document.getElementById('message').value;
          const response = await fetch(\`/send?u=\${username}&m=\${encodeURIComponent(message)}\`);
          const responseText = await response.text();
          if (response.status === 429 || response.status === 403) {
            alert(responseText);
          }
          document.getElementById('message').value = '';
          fetchMessages();
        });

        window.addEventListener('load', () => {
          localStorage.removeItem('username'); // Clear saved username on page load
          const savedUsername = localStorage.getItem('username');
          if (savedUsername) {
            username = savedUsername;
            document.getElementById('usernameModal').style.display = 'none';
            fetchMessages();
            setInterval(fetchMessages, 5000);
          } else {
            document.getElementById('usernameModal').style.display = 'flex';
          }
        });
      </script>
    </body>
    </html>
  `;
}
