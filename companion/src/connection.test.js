import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnection } from './connection.js';

test('opens pairing URL but persists only relay home', () => {
  assert.deepEqual(parseConnection('https://pane.example.com/relay/#pair=abc_def-123'), {
    openUrl: 'https://pane.example.com/relay/#pair=abc_def-123', homeUrl: 'https://pane.example.com/relay/', isPairing: true
  });
});
test('permits USB localhost and HTTPS', () => {
  assert.equal(parseConnection('http://localhost:48321/').homeUrl, 'http://localhost:48321/');
  assert.equal(parseConnection(' https://pane.example.com ').homeUrl, 'https://pane.example.com/');
});
test('rejects insecure remote addresses, credentials and unrecognized input', () => {
  for (const value of ['javascript:alert(1)', 'file:///a', 'http://192.168.1.5/', 'http://127.0.0.1/', 'https://user:pass@pane.example.com/', 'https://pane.example.com/?token=secret', 'https://pane.example.com/#token=secret', 'https://pane.example.com/#pair=a&pair=b', 'https://pane.example.com/a%2fb', 'https://pane.exa\nmple.com/']) {
    assert.throws(() => parseConnection(value), undefined, value);
  }
});
