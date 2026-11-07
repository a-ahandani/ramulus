import { afterEach, expect, it, vi } from 'vitest'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: unknown[] = []
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  say(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('attaches a tab before what was typed, and attaches it again when the socket comes back', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  const { httpBackend } = await import('./remote')
  const out: [string, boolean][] = []
  let exits = 0
  const link = httpBackend('http://127.0.0.1:1', 't', '/repo').termAttach!('a', (d, replay) => out.push([d, replay]), () => exits++)
  const attach = { op: 'attach', ch: 1, repo: '/repo', id: 'a' }

  link.input('ls\r')
  const first = FakeSocket.all[0]
  expect(first.url).toBe('ws://127.0.0.1:1/api/term?token=t')
  first.open()
  expect(first.sent).toEqual([attach, { op: 'input', ch: 1, data: 'ls\r' }])
  first.say({ ch: 1, replay: 'before' })
  first.say({ ch: 1, data: 'after' })
  expect(out).toEqual([
    ['before', true],
    ['after', false],
  ])

  // typing while it is gone waits for the tab to attach again
  first.close()
  link.input('pwd\r')
  vi.advanceTimersByTime(1000)
  const second = FakeSocket.all[1]
  second.open()
  expect(second.sent).toEqual([attach, { op: 'input', ch: 1, data: 'pwd\r' }])

  second.say({ ch: 1, exit: 0 })
  expect(exits).toBe(1)
  link.input('ignored')
  link.close()
  expect(second.sent.slice(2)).toEqual([{ op: 'detach', ch: 1 }])
  // with no tab left, a dropped socket stays down
  second.close()
  vi.advanceTimersByTime(5000)
  expect(FakeSocket.all).toHaveLength(2)
})
