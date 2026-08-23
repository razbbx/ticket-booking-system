export function getCorsHeaders(request) {
  const origin = request ? (request.headers.get('Origin') || '*') : '*';
  const reqHeaders = request ? (request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization') : 'Content-Type, Authorization';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders,
    'Access-Control-Max-Age': '86400',
  };
}

export function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
  });
}

export function error(status, message, request = null) {
  return json({ error: message }, status, request);
}

export function corsResponse(request) {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}