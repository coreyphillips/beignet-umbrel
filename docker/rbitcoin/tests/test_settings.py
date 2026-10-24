import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import HTTPServer

spec = importlib.util.spec_from_file_location('settings', Path(__file__).parents[1] / 'settings.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings = module.Settings(self.directory.name)

    def test_defaults_and_persistence_across_relaunch(self):
        initial = self.settings.snapshot()
        self.assertEqual(initial['saved'], module.DEFAULTS)
        self.settings.launch_args(['--network', 'regtest'])
        self.assertFalse(self.settings.snapshot()['restartRequired'])
        values = {**module.DEFAULTS, 'maxOutbound': 8, 'mempoolSize': 500}
        saved = self.settings.save(values, initial['revision'])
        self.assertTrue(saved['restartRequired'])
        reopened = module.Settings(self.directory.name)
        self.assertEqual(reopened.saved(), values)
        args = reopened.launch_args(['--network', 'regtest'])
        self.assertEqual(args[:6], ['--max-outbound', '8', '--max-inbound', '125', '--mempool-size-mb', '500'])
        self.assertFalse(reopened.snapshot()['restartRequired'])
        self.assertEqual(reopened.snapshot()['lastLaunched'], values)

    def test_stale_revision_cannot_overwrite_another_window(self):
        revision = self.settings.snapshot()['revision']
        self.settings.save({**module.DEFAULTS, 'maxOutbound': 8}, revision)
        with self.assertRaises(FileExistsError):
            self.settings.save(module.DEFAULTS, revision)
        self.assertEqual(self.settings.saved()['maxOutbound'], 8)

    def test_invalid_values_never_modify_saved_settings(self):
        initial = self.settings.snapshot()
        cases = [None, [], {}, {**module.DEFAULTS, 'command': 'anything'}]
        for key, value in [('maxOutbound', 0), ('maxOutbound', 129), ('maxInbound', -1),
                           ('maxInbound', 1001), ('mempoolSize', 0), ('mempoolSize', 16385),
                           ('maxOutbound', True), ('maxOutbound', 2.5), ('maxOutbound', '16'),
                           ('logLevel', 'info; touch /tmp/unwanted'), ('logLevel', None)]:
            cases.append({**module.DEFAULTS, key: value})
        for invalid in cases:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.settings.save(invalid, initial['revision'])
        self.assertEqual(self.settings.snapshot(), initial)

    def test_explicit_cli_flags_win_and_are_reported(self):
        args = ['--max-outbound', '9', '--log-level=debug', '--network', 'regtest']
        launched = self.settings.launch_args(args)
        self.assertEqual(launched[-len(args):], args)
        self.assertEqual(self.settings.snapshot()['lastLaunched']['maxOutbound'], 9)
        self.assertEqual(self.settings.snapshot()['lastLaunched']['logLevel'], 'debug')
        self.assertTrue(self.settings.snapshot()['restartRequired'])

    def test_corrupt_file_is_not_silently_reset(self):
        path = Path(self.directory.name) / 'settings.json'
        path.write_text('{oops')
        with self.assertRaises(ValueError):
            self.settings.launch_args([])
        self.assertEqual(path.read_text(), '{oops')
        self.assertFalse((path.parent / 'launched.json').exists())

    def test_api_saves_and_protects_browser_writes(self):
        server = HTTPServer(('127.0.0.1', 0), module.handler_for(self.settings))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        host = f'127.0.0.1:{server.server_port}'

        def request(method, body=None, headers=None, path='/settings'):
            connection = http.client.HTTPConnection(host, timeout=2)
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            data = response.read()
            connection.close()
            return response.status, json.loads(data)

        status, initial = request('GET')
        self.assertEqual(status, 200)
        payload = json.dumps({'settings': {**module.DEFAULTS, 'maxInbound': 0}, 'revision': initial['revision']})
        headers = {'Origin': f'http://{host}', 'X-Requested-With': 'rbitcoin-dashboard', 'Content-Type': 'application/json'}
        self.assertEqual(request('PUT', payload)[0], 403)
        self.assertEqual(request('PUT', payload, {**headers, 'Origin': 'https://other.test'})[0], 403)
        self.assertEqual(request('PUT', payload, {**headers, 'Origin': 'http://['})[0], 403)
        self.assertEqual(request('PUT', payload, {**headers, 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(request('PUT', payload, {**headers, 'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(request('PUT', 'x' * 4097, headers)[0], 413)
        self.assertEqual(request('PUT', '[]', headers)[0], 400)
        self.assertEqual(request('PUT', payload, headers)[0], 200)
        self.assertEqual(request('PUT', payload, headers)[0], 409)
        self.assertEqual(request('GET')[1]['saved']['maxInbound'], 0)
        self.assertEqual(request('GET', path='/anything')[0], 404)
        self.assertEqual(request('GET')[1]['saved'], module.Settings(self.directory.name).saved())

    def test_source_guard_rejects_direct_and_spoofed_app_network_requests(self):
        addresses = {'web': {'10.0.0.2'}, 'proxy': {'10.0.0.3'}}
        guard = module.SourceGuard('web', ['proxy'], lambda name: addresses.get(name, set()))
        self.assertTrue(guard.allows('10.0.0.2', '10.0.0.3'))
        self.assertFalse(guard.allows('10.0.0.4', '10.0.0.3'))
        self.assertFalse(guard.allows('10.0.0.2', '10.0.0.4'))
        self.assertFalse(guard.allows('10.0.0.2', None))
        addresses.clear()
        guard.expires = 0
        self.assertFalse(guard.allows('10.0.0.2', '10.0.0.3'))

        addresses.update(web={'10.0.0.8'}, proxy={'10.0.0.9'})
        guard.expires = 0
        self.assertTrue(guard.allows('10.0.0.8', '10.0.0.9'))
        self.assertFalse(guard.allows('10.0.0.2', '10.0.0.3'))

    def test_native_gateway_works_without_a_legacy_proxy_container(self):
        route_file = Path(self.directory.name) / 'route'
        route_file.write_text('Iface Destination Gateway Flags RefCnt Use Metric Mask\n'
                              'eth0 00000000 0100150A 0003 0 0 0 00000000\n'
                              'eth0 0000150A 00000000 0001 0 0 0 0000FFFF\n'
                              'eth1 00000000 0100160A 0000 0 0 0 00000000\n')
        self.assertEqual(module.host_gateways(route_file), {'10.21.0.1'})
        self.assertEqual(module.host_gateways(route_file.parent / 'missing'), set())
        guard = module.SourceGuard('web', ['absent-proxy'],
                                   lambda host: {'10.21.0.2'} if host == 'web' else set(),
                                   lambda: module.host_gateways(route_file))
        self.assertTrue(guard.allows('10.21.0.2', '10.21.0.1'))
        self.assertFalse(guard.allows('10.21.0.2', '10.21.0.3'))
        self.assertFalse(guard.allows('10.21.0.3', '10.21.0.1'))


if __name__ == '__main__':
    unittest.main()
