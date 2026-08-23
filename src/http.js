export function getCorsHeaders(request) {
  const origin = request ? (request.headers.get('Origin') || '*') : '*';
  const reqHeaders = request ? (request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization') : 'Content-Type, Authorization';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export function applyCors(response, request) {
  const origin = request ? request.headers.get('Origin') : null;
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', origin && origin !== 'null' ? origin : '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, PATCH, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  newHeaders.set('Access-Control-Allow-Credentials', 'true');
  newHeaders.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function error(status, message) {
  return json({ error: message }, status);
}

export function corsResponse(request) {
  return applyCors(new Response(null, { status: 204 }), request);
}