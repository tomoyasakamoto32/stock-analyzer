import { test } from 'node:test'
import assert from 'node:assert/strict'
import { likeSafe, resolveCode, searchKey, type Suggestion } from '../src/shared/search.ts'

test('検索キー: 全角半角・大小文字・カタカナ/ひらがな・記号と空白の差を吸収する', () => {
  const k = searchKey('フジクラ')
  for (const v of ['ふじくら', 'ﾌｼﾞｸﾗ', 'フジ クラ', 'フジ・クラ', 'ふじクラ']) assert.equal(searchKey(v), k, v)
  assert.equal(searchKey('ＮＴＴ'), searchKey('ntt'))
  assert.equal(searchKey('Ｔ＆Ｄホールディングス'), searchKey('t&d ホールディングス'))
  assert.equal(searchKey('（株）テスト'), searchKey('株テスト'))
  assert.notEqual(searchKey('フジクラ'), searchKey('フジテック'))
  assert.equal(searchKey(''), '')
  assert.equal(searchKey('285a'), '285a')
})

const S = (code: string, name: string): Suggestion => ({ code, name, market: 'Prime', industry: null })

test('銘柄の確定: 4桁コードの直接入力はそのまま使う(英数字・小文字も可)', () => {
  assert.deepEqual(resolveCode(' 7203 ', null, []), { code: '7203', reason: null })
  assert.deepEqual(resolveCode('285a', null, []), { code: '285A', reason: null })
})

test('銘柄の確定: 選択済みの候補・候補が1件・名前が完全一致する1件のときだけ確定する', () => {
  const fj = S('5803', 'フジクラ')
  assert.equal(resolveCode('5803 フジクラ', fj, [fj, S('5802', '住友電気工業')]).code, '5803')
  assert.equal(resolveCode('フジクラ', fj, []).code, '5803')
  assert.equal(resolveCode('ふじ', null, [fj]).code, '5803', '候補が1件ならそれを使う')
  assert.equal(resolveCode('ふじくら', null, [fj, S('5804', 'フジクラ工業')]).code, '5803', '名前の完全一致が1件ならそれを使う')
})

test('銘柄の確定: 曖昧・該当なし・空は確定せず、理由を返す(推測で別の銘柄にしない)', () => {
  const two = [S('5803', 'フジクラ'), S('5804', 'フジクラ工業')]
  const a = resolveCode('ふじ', null, two)
  assert.equal(a.code, null)
  assert.match(a.reason!, /候補から/)
  const b = resolveCode('そんな会社', null, [])
  assert.equal(b.code, null)
  assert.match(b.reason!, /見つかりません/)
  assert.equal(resolveCode('  ', null, []).code, null)
  // 3桁・5桁は直接入力として扱わない
  assert.equal(resolveCode('720', null, []).code, null)
  assert.equal(resolveCode('72030', null, []).code, null)
})


test('LIKEパターンの長さ制限(D1は50バイト): 長い日本語入力でも、前後の%を付けて50バイト以内に収める', () => {
  const enc = new TextEncoder()
  for (const s of ['あ'.repeat(100), 'a'.repeat(100), '%_%_'.repeat(30), '株'.repeat(16), '']) {
    const p = `%${likeSafe(s)}%`
    assert.ok(enc.encode(p).length <= 50, `${s.slice(0, 6)}… ${enc.encode(p).length}bytes`)
  }
  assert.equal(likeSafe('フジクラ'), 'フジクラ')
  assert.equal(likeSafe('100%'), '100\\%', 'LIKEの特殊文字はエスケープする')
  assert.equal([...likeSafe('あ'.repeat(100))].length, 15, '日本語は15文字まで')
})
