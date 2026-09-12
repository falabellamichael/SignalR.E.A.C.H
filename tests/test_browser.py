"""Security and routing contracts for the local browser's document fetcher."""

import gzip
import io
import json
import socket
import sys
import time
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd import browser
from reachd.handler import RelayHandler


PUBLIC_ADDRESS = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
                  ("93.184.216.34", 443))


class FakeResponse(io.BytesIO):
    def __init__(self, data=b"<html><title>Example</title><p>Page text</p></html>",
                 status=200, content_type="text/html; charset=utf-8", headers=None):
        super().__init__(data)
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        for key, value in (headers or {}).items():
            self.headers[key] = value

    def getheader(self, name):
        return self.headers.get(name)


class BrowserFetchTests(unittest.TestCase):
    def setUp(self):
        self.lookup = patch.object(browser.socket, "getaddrinfo", return_value=[PUBLIC_ADDRESS]).start()
        self.connections = []
        self.responses = [FakeResponse()]

        def connect(*args):
            connection = Mock()
            connection.getresponse.return_value = self.responses.pop(0)
            self.connections.append(connection)
            return connection

        self.connection = patch.object(browser, "_PinnedConnection", side_effect=connect).start()
        self.addCleanup(patch.stopall)

    def test_rejects_unsafe_url_schemes_credentials_and_invalid_authority(self):
        for url in (None, {}, "", "file:///etc/passwd", "ftp://example.com", "https://user:secret@example.com",
                    "https://example.com:0", "https://example.com:65536", "https://example.com\\@127.0.0.1",
                    "https://[fe80::1%25eth0]", "https://example.com/\r\nHeader: value"):
            with self.subTest(url=url), self.assertRaises(browser.BrowserError):
                browser.fetch_page(url)
        self.lookup.assert_not_called()
        self.connection.assert_not_called()

    def test_raster_resource_uses_base64_and_checks_actual_format(self):
        png = b'\x89PNG\r\n\x1a\n' + b'fixture'
        self.responses = [FakeResponse(png, content_type='image/png')]
        result = browser.fetch_page('https://example.com/logo.png', kind='image')
        self.assertEqual(result['encoding'], 'base64')
        self.assertEqual(browser.base64.b64decode(result['data']), png)
        self.responses = [FakeResponse(b'<html>not an image</html>', content_type='image/png')]
        with self.assertRaises(browser.BrowserError):
            browser.fetch_page('https://example.com/fake.png', kind='image')

    def test_svg_images_are_returned_as_inert_base64(self):
        svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
               b'<rect width="10" height="10" fill="red"/></svg>')
        self.responses = [FakeResponse(svg, content_type='image/svg+xml')]
        result = browser.fetch_page('https://example.com/icon.svg', kind='image')
        self.assertEqual(result['encoding'], 'base64')
        self.assertEqual(result['content_type'], 'image/svg+xml')
        self.assertEqual(browser.base64.b64decode(result['data']), svg)

    def test_compressed_responses_are_decoded_within_the_cap(self):
        payload = b'<html><title>Zipped &amp; compressed</title><p>Hello world.</p></html>'
        self.responses = [FakeResponse(gzip.compress(payload), content_type='text/html; charset=utf-8',
                                       headers={'Content-Encoding': 'gzip'})]
        result = browser.fetch_page('https://example.com')
        self.assertEqual(result['title'], 'Zipped & compressed')
        self.assertEqual(result['text'], 'Hello world.')
        with patch.object(browser, 'MAX_PAGE_BYTES', 50):
            self.responses = [FakeResponse(gzip.compress(b'<html><p>' + b'x' * 200 + b'</p></html>'),
                                           content_type='text/html',
                                           headers={'Content-Encoding': 'gzip'})]
            result = browser.fetch_page('https://example.com')
        self.assertTrue(result['truncated'])

    def test_stylesheet_resource_is_text_and_scripts_svg_html_are_rejected(self):
        self.responses = [FakeResponse(b'body { color: red; }', content_type='text/css')]
        self.assertEqual(browser.fetch_page('https://example.com/site.css', kind='style')['data'], 'body { color: red; }')
        for kind, content_type in [('style', 'text/html'), ('style', 'text/javascript'), ('image', 'image/tiff')]:
            self.responses = [FakeResponse(b'content', content_type=content_type)]
            with self.subTest(kind=kind, content_type=content_type), self.assertRaises(browser.BrowserError):
                browser.fetch_page('https://example.com/resource', kind=kind)

    def test_resources_enforce_size_limit_and_private_redirect_gate(self):
        self.responses = [FakeResponse(b'x' * (512 * 1024 + 1), content_type='text/css')]
        with self.assertRaises(browser.BrowserError) as exc:
            browser.fetch_page('https://example.com/large.css', kind='style')
        self.assertEqual(exc.exception.code, 'resource_too_large')
        self.responses = [FakeResponse(status=302, headers={'Location': 'http://127.0.0.1/private'})]
        self.lookup.side_effect = [[PUBLIC_ADDRESS], [(*PUBLIC_ADDRESS[:4], ('127.0.0.1', 80))]]
        with self.assertRaises(browser.BrowserError) as exc:
            browser.fetch_page('https://example.com/logo', kind='image')
        self.assertEqual(exc.exception.code, 'blocked_address')

    def test_loopback_first_hop_is_allowed_for_local_dev(self):
        loopback_addr = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
                         ("127.0.0.1", 18111))
        self.lookup.return_value = [loopback_addr]
        result = browser.fetch_page('http://localhost:18111/comfy/')
        self.assertEqual(result['url'], 'http://localhost:18111/comfy/')
        self.assertEqual(result['title'], 'Example')

    def test_private_reserved_and_mixed_dns_results_are_blocked(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1",
                        "100.100.100.200", "0.0.0.0", "224.0.0.1", "240.0.0.1", "::1", "::",
                        "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1",
                        "2002:7f00:1::", "2001:db8::1"):
            self.lookup.return_value = [PUBLIC_ADDRESS, (*PUBLIC_ADDRESS[:4], (address, 443))]
            with self.subTest(address=address), self.assertRaises(browser.BrowserError) as exc:
                browser.fetch_page("https://example.com")
            self.assertEqual(exc.exception.code, "blocked_address")
        self.connection.assert_not_called()

    def test_redirect_to_private_host_is_revalidated_before_connecting(self):
        self.responses = [FakeResponse(status=302, headers={"Location": "http://127.0.0.1/admin"})]
        self.lookup.side_effect = [[PUBLIC_ADDRESS], [(*PUBLIC_ADDRESS[:4], ("127.0.0.1", 80))]]
        with self.assertRaises(browser.BrowserError) as exc:
            browser.fetch_page("https://example.com")
        self.assertEqual(exc.exception.code, "blocked_address")
        self.assertEqual(self.connection.call_count, 1)
        self.connections[0].finish.assert_called_once()

    def test_redirect_loop_has_bounded_requests(self):
        self.responses = [FakeResponse(status=302, headers={"Location": "/loop"})
                          for _ in range(browser.MAX_REDIRECTS + 1)]
        with self.assertRaises(browser.BrowserError) as exc:
            browser.fetch_page("https://example.com")
        self.assertEqual(exc.exception.code, "redirect_failed")
        self.assertEqual(self.connection.call_count, browser.MAX_REDIRECTS + 1)

    def test_returns_page_title_readable_text_and_final_url_without_forwarded_secrets(self):
        self.responses = [FakeResponse(status=302, headers={"Location": "/article?q=hello#part"}),
                          FakeResponse(b"<head><title>A &amp; B</title><style>hidden-css</style></head>"
                                       b"<h1>Heading</h1><p>Hello <b>world</b>.</p><script>hidden-script</script>")]
        result = browser.fetch_page("https://example.com")
        self.assertEqual(result["url"], "https://example.com/article?q=hello")
        self.assertEqual(result["title"], "A & B")
        self.assertEqual(result["text"], "Heading\nHello world.")
        self.assertIn("<script>", result["html"])  # explicitly untrusted HTML for frontend sanitizer
        self.assertFalse(result["truncated"])
        for connection in self.connections:
            headers = connection.request.call_args.kwargs["headers"]
            self.assertEqual(headers["Accept-Encoding"], "identity")
            self.assertFalse({"Cookie", "Authorization", "X-Reach-Key", "X-Reach-Admin"} & headers.keys())
            connection.finish.assert_called_once()

    def test_plain_text_and_unknown_charset_are_supported(self):
        self.responses = [FakeResponse(b"Plain text\n<not html>", content_type="text/plain; charset=unknown-charset")]
        result = browser.fetch_page("https://example.com")
        self.assertEqual(result["html"], "")
        self.assertEqual(result["text"], "Plain text\n<not html>")
        self.assertEqual(result["content_type"], "text/plain")

    def test_response_cap_is_enforced_and_marks_truncation(self):
        response = FakeResponse(b"x" * 101, content_type="text/plain")
        self.responses = [response]
        with patch.object(browser, "MAX_PAGE_BYTES", 100):
            result = browser.fetch_page("https://example.com")
        self.assertEqual(len(result["text"]), 100)
        self.assertTrue(result["truncated"])
        self.assertTrue(response.closed)

    def test_binary_compressed_and_failed_responses_are_rejected(self):
        for response, code in ((FakeResponse(content_type="application/pdf"), "unsupported_content"),
                               (FakeResponse(headers={"Content-Encoding": "gzip"}), "unsupported_content"),
                               (FakeResponse(status=403), "fetch_failed")):
            self.responses = [response]
            with self.assertRaises(browser.BrowserError) as exc:
                browser.fetch_page("https://example.com")
            self.assertEqual(exc.exception.code, code)
            self.assertTrue(response.closed)

    def test_busy_fetch_does_not_queue_more_work(self):
        with patch.object(browser, "_FETCH_SLOTS") as slots:
            slots.acquire.return_value = False
            with self.assertRaises(browser.BrowserError) as exc:
                browser.fetch_page("https://example.com")
            self.assertEqual(exc.exception.status, 429)
            slots.release.assert_not_called()
        self.connection.assert_not_called()

    def test_dns_timeout_is_reported_and_dns_queue_is_bounded(self):
        future = Mock()
        future.result.side_effect = browser.concurrent.futures.TimeoutError()
        with patch.object(browser, "_DNS_POOL") as pool, patch.object(browser, "_DNS_SLOTS") as slots:
            slots.acquire.return_value = True
            pool.submit.return_value = future
            with self.assertRaises(browser.BrowserError) as exc:
                browser.fetch_page("https://example.com")
            self.assertEqual(exc.exception.status, 504)
            slots.release.assert_not_called()
            # A hung lookup keeps its slot until its underlying worker ends.
            future.add_done_callback.call_args.args[0](future)
            slots.release.assert_called_once()
        self.connection.assert_not_called()


class PinnedSocketTests(unittest.TestCase):
    def test_validated_address_is_used_directly_and_tls_checks_original_host(self):
        sock, secure_sock, context = Mock(), Mock(), Mock()
        context.wrap_socket.return_value = secure_sock
        with patch.object(browser.socket, "socket", return_value=sock), \
             patch.object(browser.socket, "getaddrinfo") as lookup, \
             patch.object(browser.ssl, "create_default_context", return_value=context), \
             patch.object(browser.threading, "Timer") as timer:
            connection = browser._PinnedConnection("example.com", 443, PUBLIC_ADDRESS, True,
                                                   time.monotonic() + 12)
            connection.connect()
            sock.connect.assert_called_once_with(("93.184.216.34", 443))
            lookup.assert_not_called()
            context.wrap_socket.assert_called_once_with(sock, server_hostname="example.com",
                                                       do_handshake_on_connect=False)
            secure_sock.do_handshake.assert_called_once()
            # The deadline survives HTTPConnection handing off a closing response.
            connection.close()
            timer.return_value.cancel.assert_not_called()
            connection._expire()
            secure_sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
            connection.finish()
            timer.return_value.cancel.assert_called_once()


class BrowserRouteTests(unittest.TestCase):
    def handler(self, body=None, headers=None, peer="127.0.0.1"):
        handler = object.__new__(RelayHandler)
        handler.path = "/_reach/browser/fetch"
        handler.client_address = (peer, 12345)
        raw = json.dumps(body if body is not None else {"url": "https://example.com"}).encode()
        handler.headers = {"Content-Length": str(len(raw)), **(headers or {})}
        handler.rfile = io.BytesIO(raw)
        handler._json = Mock()
        return handler

    def test_only_direct_local_clients_can_fetch_even_with_admin_token(self):
        for headers, peer in (({}, "198.51.100.1"), ({"X-Forwarded-For": "198.51.100.1"}, "127.0.0.1"),
                              ({"Cf-Connecting-Ip": "198.51.100.1", "X-Reach-Admin": "valid-admin-token"}, "127.0.0.1"),
                              ({"Forwarded": "for=127.0.0.1"}, "127.0.0.1")):
            handler = self.handler(headers=headers, peer=peer)
            with patch("reachd.handler.fetch_page") as fetch:
                handler.do_POST()
            fetch.assert_not_called()
            self.assertEqual(handler._json.call_args.args[0], 403)

    def test_local_fetch_returns_document_without_caching(self):
        handler = self.handler()
        result = {"url": "https://example.com", "title": "Example", "html": "", "text": "Hello",
                  "content_type": "text/plain", "truncated": False}
        with patch("reachd.handler.fetch_page", return_value=result) as fetch:
            handler.do_POST()
        fetch.assert_called_once_with("https://example.com")
        handler._json.assert_called_once_with(200, result, {"Cache-Control": "no-store"})

    def test_resource_route_is_local_only_and_restricts_kinds(self):
        handler = self.handler(body={'url': 'https://example.com/logo.png', 'kind': 'image'})
        handler.path = '/_reach/browser/resource'
        with patch('reachd.handler.fetch_page', return_value={'data': 'test'}) as fetch:
            handler.do_POST()
        fetch.assert_called_once_with('https://example.com/logo.png', kind='image')
        for headers, kind in [({'X-Forwarded-For': '198.51.100.2'}, 'image'), ({}, 'script'), ({}, 'page')]:
            handler = self.handler(body={'url': 'https://example.com/resource', 'kind': kind}, headers=headers)
            handler.path = '/_reach/browser/resource'
            with patch('reachd.handler.fetch_page') as fetch:
                handler.do_POST()
            fetch.assert_not_called()
            self.assertEqual(handler._json.call_args.args[0], 403 if headers else 400)

    def test_invalid_and_oversize_input_do_not_call_fetch(self):
        for body, headers in (([], {}), ({}, {"Content-Length": "17000"}),
                               ({}, {"Content-Length": "garbage"})):
            handler = self.handler(body=body, headers=headers)
            with patch("reachd.handler.fetch_page") as fetch:
                handler.do_POST()
            fetch.assert_not_called()
            self.assertEqual(handler._json.call_args.args[0], 400)

    def test_fetch_error_preserves_status_and_clear_message(self):
        handler = self.handler()
        with patch("reachd.handler.fetch_page", side_effect=browser.BrowserError("Blocked", 403, "blocked_address")):
            handler.do_POST()
        status, result = handler._json.call_args.args
        self.assertEqual(status, 403)
        self.assertEqual(result["error"]["code"], "blocked_address")


if __name__ == "__main__":
    unittest.main()
