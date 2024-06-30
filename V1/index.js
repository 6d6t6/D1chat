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
    } else {
      return new Response("Not Found", { status: 404 });
    }
  }
};
