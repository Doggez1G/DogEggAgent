import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ConfigEditor } from '../../src/config/editor'
import { ConfigStore } from '../../src/config'

// 配置编辑原语单测：S3/S4 新增的两个原语——provider.protocol 字段编辑（协议选择的落点）
// 与 setMcpServers 整组替换（/mcp 面板全局写入）。

function makeEditor(): ConfigEditor {
  const config = new ConfigStore().load({
    providers: [{ name: 'blue', protocol: 'openai', baseURL: 'https://api.example.com/v1', apiKey: 'k', models: [{ name: 'glm-5.3-flash' }] }],
  })
  return new ConfigEditor(config)
}

describe('ConfigEditor protocol 字段', () => {
  it("set('providers.<i>.protocol') 编辑协议并过 zod 校验", () => {
    const e = makeEditor()
    const result = e.set('providers.0.protocol', 'openai')
    expect(result.ok).toBe(true)
    expect(e.getConfig().providers[0]!.protocol).toBe('openai')
  })

  it('protocol 写入不支持的值 → zod 校验失败并回滚', () => {
    const e = makeEditor()
    const result = e.set('providers.0.protocol', 'grpc')
    expect(result.ok).toBe(false)
    expect(e.getConfig().providers[0]!.protocol).toBe('openai') // 回滚保持原值
  })
})

describe('ConfigEditor setMcpServers', () => {
  it('整组替换 + 校验 + 落定到 getConfig', () => {
    const e = makeEditor()
    const result = e.setMcpServers([{ name: 'fs', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] } }])
    expect(result.ok).toBe(true)
    expect(e.getConfig().mcpServers).toHaveLength(1)
    expect(e.getConfig().mcpServers[0]!.name).toBe('fs')
  })

  it('非法条目（transport 类型未知）→ 校验失败回滚', () => {
    const e = makeEditor()
    const before = e.getConfig().mcpServers
    const result = e.setMcpServers([{ name: 'bad', enabled: true, transport: { type: 'unicorn' } as never }])
    expect(result.ok).toBe(false)
    expect(e.getConfig().mcpServers).toEqual(before)
  })
})

describe('ConfigStore 默认落盘路径接缝', () => {
  it('注入 defaultPath 后 save 落到指定文件（测试隔离的根基）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogegg-cfgstore-'))
    const target = join(dir, 'config.json')
    const store = new ConfigStore(target)
    const config = store.load({ providers: [{ name: 'x', protocol: 'openai', baseURL: 'u', apiKey: 'k', models: [] }] })
    store.save(config)
    const raw = JSON.parse(readFileSync(target, 'utf8'))
    expect(raw.providers[0].name).toBe('x')
  })
})
