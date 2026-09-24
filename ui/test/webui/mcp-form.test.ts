import { describe, it, expect } from 'vitest'
import { emptyForm, formToServer, serverToForm, type FormState, type McpItem } from '../../src/webui/components/settings/mcp-form'

// MCP server 表单纯逻辑单测——重点回归「编辑保留 enabled」与字段校验。

const stdioItem = (overrides: Partial<McpItem> = {}): McpItem => ({
  name: 'fs',
  enabled: true,
  scope: 'global',
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] },
  status: 'running',
  tools: [],
  ...overrides,
})

const httpForm = (overrides: Partial<FormState> = {}): FormState => ({
  ...emptyForm('global'),
  name: 'gh',
  type: 'http',
  url: 'https://example.com/mcp',
  ...overrides,
})

describe('serverToForm', () => {
  it('stdio 条目全字段预填（command/args/env）', () => {
    const f = serverToForm(stdioItem())
    expect(f).toMatchObject({ name: 'fs', scope: 'global', type: 'stdio', command: 'npx', args: '["-y","mcp-fs"]', env: '' })
  })
  it('http 条目预填 url/headers', () => {
    const f = serverToForm(stdioItem({ transport: { type: 'http', url: 'https://x.dev', headers: { Authorization: 'Bearer t' } } }))
    expect(f).toMatchObject({ type: 'http', url: 'https://x.dev', headers: '{"Authorization":"Bearer t"}' })
  })
  it('携带原条目的 enabled（编辑保存时透传，不丢启停状态）', () => {
    expect(serverToForm(stdioItem({ enabled: false })).enabled).toBe(false)
    expect(serverToForm(stdioItem({ enabled: true })).enabled).toBe(true)
  })
})

describe('formToServer', () => {
  it('stdio 表单 → server 配置，enabled 缺省 true（新建态）', () => {
    const r = formToServer({ ...emptyForm('project'), name: 'fs', command: 'node', args: '["srv.js"]' })
    expect(r).toEqual({ name: 'fs', enabled: true, transport: { type: 'stdio', command: 'node', args: ['srv.js'] } })
  })
  it('enabled 透传表单值——停用中的 server 编辑保存不会被误启（回归硬编码 true）', () => {
    const r = formToServer({ ...httpForm(), enabled: false })
    expect('error' in r ? undefined : r.enabled).toBe(false)
  })
  it('http 表单 → server 配置；headers 为空时不带该字段', () => {
    const r = formToServer(httpForm())
    expect(r).toEqual({ name: 'gh', enabled: true, transport: { type: 'http', url: 'https://example.com/mcp' } })
    const withHeaders = formToServer(httpForm({ headers: '{"A":"b"}' }))
    expect('error' in withHeaders ? undefined : withHeaders.transport).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: { A: 'b' } })
  })
  it('名称 trim 后非空才有效；空白名返回 error', () => {
    expect(formToServer({ ...httpForm(), name: '  ' })).toEqual({ error: '缺少名称' })
    const r = formToServer({ ...httpForm(), name: '  gh  ' })
    expect('error' in r ? undefined : r.name).toBe('gh')
  })
  it('stdio 缺 command / args 非法 JSON / env 非法 JSON 均返回 error', () => {
    expect(formToServer({ ...emptyForm('global'), name: 'x', command: '' })).toEqual({ error: '缺少 command' })
    expect(formToServer({ ...emptyForm('global'), name: 'x', command: 'n', args: '{oops}' })).toEqual({ error: 'args 不是合法 JSON 数组' })
    expect(formToServer({ ...emptyForm('global'), name: 'x', command: 'n', env: 'not json' })).toEqual({ error: 'env 不是合法 JSON 对象' })
  })
  it('http 缺 url / headers 非法 JSON 均返回 error', () => {
    expect(formToServer({ ...emptyForm('global'), name: 'x', type: 'http', url: '' })).toEqual({ error: '缺少 url' })
    expect(formToServer({ ...httpForm(), headers: 'nope' })).toEqual({ error: 'headers 不是合法 JSON 对象' })
  })
})
