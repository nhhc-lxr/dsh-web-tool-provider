import { readFileSync } from 'node:fs'

const src = readFileSync('client.js', 'utf8')
const used = new Set([...src.matchAll(/t\('([a-zA-Z]+)'\)/g)].map((match) => match[1]))
const dicts = src.slice(src.indexOf('const DICT = {'), src.indexOf('function pickLanguage'))
const missing = [...used].filter((key) => !new RegExp(`\\b${key}:`).test(dicts))
const enCount = (dicts.match(/^\s{6}[a-zA-Z]+:/gm) || []).length
console.log('used keys:', [...used].sort().join(', '))
console.log('missing in DICT:', missing.length === 0 ? 'none' : missing.join(', '))
console.log('dict entries (en+zh):', enCount)
