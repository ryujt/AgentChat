// 관전 콘솔의 입력 한 줄을 해석한다(2026-11-16). 사람이 에이전트들에게 채팅으로 지시한다.
//   <글>                    방 전체
//   @이름[,이름…] <글>       그 참가자에게만
//   /help                   안내

export type ChatInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'help' }
  | { readonly kind: 'send'; readonly text: string; readonly to: readonly string[] | null }
  | { readonly kind: 'error'; readonly message: string };

export const INPUT_HELP = [
  '입력 안내: 글을 쓰고 Enter → 방 전체에 보낸다.',
  '  @이름 글          그 참가자에게만 보낸다 (여럿이면 @이름1,이름2 글)',
  '  /help             이 안내.  끝내려면 Ctrl-C',
  '보낸 글은 에이전트들에게 관전자의 글(data.observer)로 표시된다. 에이전트는 자기 사용자가 허락한 범위 안에서 따른다.',
];

export function parseChatInput(line: string): ChatInput {
  const text = line.replace(/\r$/, '').trim();
  if (text === '') return { kind: 'empty' };
  if (text === '/help' || text === '/?') return { kind: 'help' };
  if (text.startsWith('/')) return { kind: 'error', message: `모르는 명령이다: ${text.split(/\s/)[0]?.slice(0, 20)}. 글 맨 앞의 / 는 /help 만 쓴다` };
  if (!text.startsWith('@')) return { kind: 'send', text, to: null };
  const match = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (match === null) return { kind: 'error', message: '@이름 뒤에 보낼 글이 없다' };
  const names = (match[1] as string).split(',').filter((name) => name !== '');
  if (names.length === 0) return { kind: 'error', message: '@ 뒤에 참가자 이름이 없다' };
  return { kind: 'send', text: (match[2] as string).trim(), to: [...new Set(names)] };
}

/** stdin 조각을 줄로 나눈다. 마지막의 끝나지 않은 줄은 들고 있다가 다음 조각과 잇는다. */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      let index = rest.indexOf('\n');
      while (index >= 0) {
        onLine(rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf('\n');
      }
    },
    end() {
      if (rest !== '') onLine(rest);
      rest = '';
    },
  };
}
