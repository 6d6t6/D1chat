export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (request.method === "GET" && url.pathname === "/send") {
      const user = url.searchParams.get("u");
      const message = url.searchParams.get("m");
      
      if (user && message) {
        await env.DB.prepare("INSERT INTO messages (user, message) VALUES (?, ?)")
                    .bind(user, message)
                    .run();
        return new Response("Message sent", { status: 200 });
      } else {
        return new Response("Missing user or message", { status: 400 });
      }
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
          await fetch(\`/send?u=\${username}&m=\${encodeURIComponent(message)}\`);
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
