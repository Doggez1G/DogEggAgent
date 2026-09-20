import { describe, it, expect } from 'vitest'
import { parseConfigSet, parseConfigAdd } from '../../../src/config/editor'

describe('parseConfigSet', () => {
  it('顶层标量：string 字段', () => {
    expect(parseConfigSet('defaultProvider', 'openai')).toEqual({ kind: 'top', field: 'defaultProvider', value: 'openai' })
    expect(parseConfigSet('systemPrompt', '/x.md')).toEqual({ kind: 'top', field: 'systemPrompt', value: '/x.md' })
  })
  it('顶层标量：number 字段', () => {
    expect(parseConfigSet('maxIterations', 99)).toEqual({ kind: 'top', field: 'maxIterations', value: 99 })
  })
  it('permission.<bucket>（v3 规则对象；非法形状键防御性丢弃）', () => {
    expect(parseConfigSet('permission.allow', { shell: { whole: false, patterns: ['git *'] }, read_file: { whole: true, patterns: [] } }))
      .toEqual({ kind: 'permission', bucket: 'allow', value: { shell: { whole: false, patterns: ['git *'] }, read_file: { whole: true, patterns: [] } } })
    // 形状非法（字符串数组/非对象）的键直接丢弃——编辑器只产合法形状，此处仅防御手写消息。
    expect(parseConfigSet('permission.allow', { shell: ['git *'], bad: 'x', read_file: { whole: true, patterns: [] } }))
      .toEqual({ kind: 'permission', bucket: 'allow', value: { read_file: { whole: true, patterns: [] } } })
  })
  it('permission 非法 bucket 返回 null', () => {
    expect(parseConfigSet('permission.nope', [])).toBeNull()
  })
  it('providers.<i>.<field>', () => {
    expect(parseConfigSet('providers.0.name', 'openai')).toEqual({ kind: 'provider', index: 0, field: 'name', value: 'openai' })
    expect(parseConfigSet('providers.1.apiKey', 'k')).toEqual({ kind: 'provider', index: 1, field: 'apiKey', value: 'k' })
  })
  it('providers 非法 index 返回 null', () => {
    expect(parseConfigSet('providers.-1.name', 'x')).toBeNull()
  })
  it('providers.<i>.models.<j>.<field>（string/number/boolean）', () => {
    expect(parseConfigSet('providers.0.models.1.name', 'gpt-4o')).toEqual({ kind: 'model', providerIndex: 0, modelIndex: 1, field: 'name', value: 'gpt-4o' })
    expect(parseConfigSet('providers.0.models.1.contextWindow', 128000)).toEqual({ kind: 'model', providerIndex: 0, modelIndex: 1, field: 'contextWindow', value: 128000 })
    expect(parseConfigSet('providers.0.models.1.reasoning', true)).toEqual({ kind: 'model', providerIndex: 0, modelIndex: 1, field: 'reasoning', value: true })
  })
  it('非法路径返回 null', () => {
    expect(parseConfigSet('unknown', 'x')).toBeNull()
    expect(parseConfigSet('providers.0.models.1.unknown', 'x')).toBeNull()
  })
})

describe('parseConfigAdd', () => {
  it('providers 追加 provider', () => {
    const value = { name: 'x', protocol: 'openai', baseURL: '', apiKey: '', models: [] }
    expect(parseConfigAdd('providers', value)).toEqual({ kind: 'provider', value })
  })
  it('providers.<i>.models 追加 model', () => {
    const value = { name: 'm', contextWindow: 128000, maxOutput: 16384, reasoning: false }
    expect(parseConfigAdd('providers.0.models', value)).toEqual({ kind: 'model', providerIndex: 0, value })
  })
  it('非法路径返回 null', () => {
    expect(parseConfigAdd('nope', {})).toBeNull()
  })
})
