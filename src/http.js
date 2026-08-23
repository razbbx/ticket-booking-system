export function applyCors(response, request) {
  const origin = request ? request.headers.get('Origin') : null;
  const newHeaders = new Headers(response.headers);

  if (origin && origin !== 'null') {
    // Credentialed cross-origin: reflect the exact origin
    newHeaders.set('Access-Control-Allow-Origin', origin);
    newHeaders.set('Access-Control-Allow-Credentials', 'true');
  } else {
    // Same-origin request (no Origin header) or file:// – use wildcard, no credentials
    newHeaders.set('Access-Control-Allow-Origin', '*');
  }

  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, PATCH, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  newHeaders.set('Access-Control-Max-Age', '86400');
  newHeaders.set('Vary', 'Origin');

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
  const origin = request ? request.headers.get('Origin') : null;
  const reqMethod = request ? request.headers.get('Access-Control-Request-Method') : null;
  const reqHeaders = request ? request.headers.get('Access-Control-Request-Headers') : null;

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders || 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (origin && origin !== 'null') {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return new Response(null, { status: 204, headers });
}