// Independent I/O fuses make negative probes safe even if the realm guard regresses.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { ROOT } from "../lib/continuity-observation-input.mjs";
const roots = [], servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("denies alternate transports before external I/O and inherits the deny floor into Node descendants", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-transport-"))); roots.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  let received = 0;
  const server = http.createServer((_, response) => { received++; response.end("owned"); }); servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const preload = join(root, "preload.mjs"), profile = { root: ROOT, home, preload, endpoint: `http://127.0.0.1:${server.address().port}/owned` };
  // These original-transport fuses are installed BEFORE the guard under test.
  // A missing guard fails with a different error, never an actual SYN/DNS packet.
  await writeFile(preload, `
    import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
    import dns from 'node:dns'; import dnsPromises from 'node:dns/promises'; import dgram from 'node:dgram';
    import{installE2NativeRealm}from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/__tests__/fixtures/e2-native-realm.mjs")).href)};
    const fuse = () => { throw Error('test_probe_original_transport_touched'); };
    net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = http.request = http.get = https.request = https.get = fuse;
    for (const target of [dns,dnsPromises,dns.Resolver.prototype,dnsPromises.Resolver.prototype]) for (const name of Object.getOwnPropertyNames(target)) if (/^(resolve|reverse|lookup)/.test(name) && typeof target[name] === 'function') target[name] = fuse;
    dgram.createSocket = fuse; dgram.Socket = class { constructor(){fuse();} }; globalThis.WebSocket = class { constructor(){fuse();} };
    await installE2NativeRealm(${JSON.stringify(profile)});
  `, { mode: 0o600 });
  const descendant = `import assert from 'node:assert/strict'; import net from 'node:net'; assert.throws(()=>net.connect(9,'192.0.2.1'),/test_external_transport_forbidden/); console.log('descendant-denied');`;
  const program = `
    import assert from 'node:assert/strict';
    import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
    import dns from 'node:dns'; import dnsPromises from 'node:dns/promises'; import dgram from 'node:dgram'; import {spawnSync} from 'node:child_process';
    const probes = [
      ()=>net.connect(9,'192.0.2.1'), ()=>net.createConnection({port:9,host:'192.0.2.1'}), ()=>new net.Socket().connect(9,'192.0.2.1'),
      ()=>net.connect(9,'127.0.0.1'), ()=>net.connect(${server.address().port},'::1'), ()=>tls.connect(443,'example.invalid'), ()=>http.request('http://example.invalid'),
      ()=>http.get('http://example.invalid'), ()=>https.request('https://example.invalid'), ()=>https.get('https://example.invalid'),
      ()=>dns.lookup('example.invalid'), ()=>dns.resolve('example.invalid'), ()=>dnsPromises.lookup('example.invalid'),
      ()=>dnsPromises.resolve('example.invalid'), ()=>new dns.Resolver().resolve('example.invalid'),
      ()=>new dnsPromises.Resolver().resolve('example.invalid'), ()=>dgram.createSocket('udp4'), ()=>new dgram.Socket('udp4'), ()=>new WebSocket('wss://example.invalid')
    ];
    for (const probe of probes) assert.throws(probe,/test_external_transport_forbidden/);
    const child = spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(descendant)}],{env:{HOME:${JSON.stringify(home)},PATH:'/usr/bin:/bin'},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); assert.equal(child.stdout.trim(),'descendant-denied');
    console.log(JSON.stringify({denied:probes.length,descendant:true}));
  `;
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", program], { cwd: ROOT, env: { HOME: home, PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const [code] = await once(child, "close"); expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ denied: 19, descendant: true }); expect(received).toBe(0);
}, 30000);
