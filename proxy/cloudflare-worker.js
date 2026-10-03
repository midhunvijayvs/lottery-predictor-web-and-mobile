// OPTIONAL: a tiny free download proxy so "Update PDF Files" works from the browser.
//
// Why: the Kerala result site does not send CORS headers, so a web page on
// github.io is not allowed to download its PDFs directly. This worker fetches
// the PDF server-side and adds the CORS header. It ONLY allows the lottery
// result domain, so it cannot be abused as an open proxy.
//
// Setup (free, ~5 minutes):
//   1. Sign up at https://dash.cloudflare.com  ->  Workers & Pages  ->  Create Worker
//   2. Replace the default code with this file, click Deploy
//   3. Copy the worker URL, e.g. https://lottery-proxy.yourname.workers.dev
//   4. In the app: Settings -> Download proxy ->  https://lottery-proxy.yourname.workers.dev/?url=
//
// Note: if the result site blocks Cloudflare's servers, use "Add PDFs from phone" instead.

const ALLOWED_HOSTS = ["result.keralalotteries.com", "statelottery.kerala.gov.in", "www.statelottery.kerala.gov.in"];

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get("url");
    let u;
    try { u = new URL(target); } catch { return new Response("Missing or bad ?url=", { status: 400, headers: cors }); }
    if (!ALLOWED_HOSTS.includes(u.hostname)) return new Response("Host not allowed", { status: 403, headers: cors });

    const upstream = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/pdf");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
