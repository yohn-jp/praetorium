"""Live, credential-free ingress checks for #66; does not certify an OAuth grant."""
import json
import socket
import urllib.error
import urllib.request

ORIGIN = 'https://1289100245.scriptorium.yohn.jp'
ISSUER = 'https://praetorium.yohn.jp'


def request(url, data=None):
    headers = {'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(65536)
        print(json.dumps({'url': url, 'status': response.status,
                          'www_authenticate': response.headers.get('WWW-Authenticate'),
                          'body': body.decode('utf-8', errors='replace') if 'json' in response.headers.get('Content-Type', '') else '<non-JSON body omitted>'}), flush=True)
        return response.status, response.headers, body


print(json.dumps({'ipv4': sorted({r[4][0] for r in socket.getaddrinfo(
    '1289100245.scriptorium.yohn.jp', 443, socket.AF_INET)})}), flush=True)
try:
    ipv6 = sorted({r[4][0] for r in socket.getaddrinfo(
        '1289100245.scriptorium.yohn.jp', 443, socket.AF_INET6)})
except socket.gaierror:
    ipv6 = []
print(json.dumps({'ipv6': ipv6, 'ipv6_https': 'NOT_CHECKED' if ipv6 else 'NO_AAAA'}), flush=True)
status, _, _ = request(ORIGIN + '/')
assert status == 200, 'public application root'
initialize = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                         'params': {'protocolVersion': '2025-03-26', 'capabilities': {},
                                    'clientInfo': {'name': 'praetorium-ingress-probe', 'version': '1'}}}).encode()
status, headers, _ = request(ORIGIN + '/mcp', initialize)
assert status == 401, 'anonymous MCP must require authorization'
assert 'resource_metadata="' + ORIGIN + '/.well-known/oauth-protected-resource"' in headers.get('WWW-Authenticate', '')
for path in ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']:
    status, _, body = request(ORIGIN + path)
    if path.endswith('/mcp') and status == 404:
        print('Path-specific resource metadata: 404; canonical WWW-Authenticate discovery checked separately.', flush=True)
        continue
    assert status == 200
    metadata = json.loads(body)
    assert metadata['resource'] == ORIGIN
    assert ISSUER in metadata['authorization_servers']
status, _, body = request(ISSUER + '/.well-known/oauth-authorization-server')
assert status == 200
metadata = json.loads(body)
assert metadata['issuer'] == ISSUER
assert metadata['registration_endpoint'] == ISSUER + '/oauth/register'
assert 'S256' in metadata['code_challenge_methods_supported']
print('PASS: public HTTPS, anonymous MCP challenge, OAuth discovery and advertised PKCE/DCR. OAuth grant and authenticated initialize: NOT_CHECKED.', flush=True)
