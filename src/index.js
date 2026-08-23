import { createRouter } from './router.js';
import { json, error, corsResponse, applyCors } from './http.js';
import { HttpError } from './auth.js';
import { runSweep } from './services/holds.js';
import * as authRoutes from './routes/auth.js';
import * as adminRoutes from './routes/admin.js';
import * as eventRoutes from './routes/events.js';
import * as seatRoutes from './routes/seats.js';
import * as waitlistRoutes from './routes/waitlist.js';
import * as bookingRoutes from './routes/bookings.js';

function buildRouter() {
  const router = createRouter();
  authRoutes.register(router);
  adminRoutes.register(router);
  eventRoutes.register(router);
  seatRoutes.register(router);
  waitlistRoutes.register(router);
  bookingRoutes.register(router);
  return router;
}

const router = buildRouter();

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return corsResponse(request);

  let body = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }

  const c = { request, env, ctx, url, body, db: env.DB };
  const handler = router.handle(method, url, c);
  if (!handler) return applyCors(error(404, 'not found'), request);

  try {
    const res = await handler;
    if (res instanceof Response) return applyCors(res, request);
    return applyCors(error(500, 'handler returned a non-Response value'), request);
  } catch (err) {
    if (err instanceof HttpError) return applyCors(error(err.status, err.message), request);
    console.error('[API ERROR]', (err && err.stack) || err);
    return applyCors(error(500, 'internal server error'), request);
  }
}

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/svc/')) return handleApi(request, env, ctx);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('<html><body><h1>Not Found</h1></body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}

export async function scheduled(event, env, ctx) {
  await runSweep(env.DB, env);
}

export default { fetch: handleFetch, scheduled };