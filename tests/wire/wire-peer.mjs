// 결함 주입이 쓰는 참가자 프로세스. 프로세스째 멈추거나(SIGSTOP) 죽여야(SIGKILL) 하는 주입(F-06, F-07)에 쓴다.
// 제품 클라이언트 코드를 쓰지 않는다. wire-client.mjs 만 쓴다.
//
//   node tests/wire/wire-peer.mjs --url <ws 주소> --room <방 ID> --peer <이름> --mode create|join [--ping-ms 5000]
//
// 입장하면 stdout 에 `joined <참가자 수>` 한 줄을 쓰고, --ping-ms 마다 ping 을 보낸다.
// 연결이 닫히면 `closed <종료 코드>` 를 쓰고 끝난다. SIGTERM 을 받으면 leave 를 보내고 끝난다.

import { argValue, newIdentity, openWire } from './wire-client.mjs';

const url = argValue('url');
const room = argValue('room');
const peer = argValue('peer');
const mode = argValue('mode') ?? 'join';
const pingMs = Number.parseInt(argValue('ping-ms') ?? '5000', 10);
if (!url || !room || !peer) {
  process.stderr.write('--url, --room, --peer 를 준다\n');
  process.exit(2);
}

const client = await openWire(url, { label: peer });
const reply = await client.join({ room, ...newIdentity(peer), mode });
if (reply.type !== 'joined') {
  process.stderr.write(`입장하지 못했다: ${reply.type === 'error' ? reply.code : reply.type}\n`);
  client.terminate();
  process.exit(1);
}

const timer = setInterval(() => {
  if (client.isOpen) client.send({ action: 'ping', id: `p${Date.now().toString(36)}` });
}, pingMs);

process.on('SIGTERM', () => {
  clearInterval(timer);
  client.leave();
  client.close();
});
process.stdout.write(`joined ${reply.members.length + 1}\n`);

const closed = await client.closed({ timeoutMs: 24 * 60 * 60 * 1000 });
clearInterval(timer);
process.stdout.write(`closed ${closed.code}\n`);
