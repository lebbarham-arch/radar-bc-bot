#!/usr/bin/env python3
import re

with open("/tmp/radar_head.js", "r", encoding="utf-8") as f:
    src = f.read()

results = []

# 1. CFG
old = 'const CFG = {\n  sbUrl:     process.env.SUPABASE_URL     || "",\n  sbKey:     process.env.SUPABASE_KEY     || "",\n  login:     process.env.PORTAL_LOGIN     || "",\n  password:  process.env.PORTAL_PASSWORD  || "",\n  tgToken:   process.env.TELEGRAM_BOT_TOKEN || "",'
new = 'const CFG = {\n  sbUrl:        process.env.SUPABASE_URL          || "",\n  sbKey:        process.env.SUPABASE_KEY          || "",\n  login:        process.env.PORTAL_LOGIN          || "",\n  password:     process.env.PORTAL_PASSWORD       || "",\n  tgToken:      process.env.TELEGRAM_BOT_TOKEN    || "",\n  anthropicKey: process.env.ANTHROPIC_API_KEY     || "",\n  ollamaUrl:    process.env.OLLAMA_URL            || "",\n  ollamaModel:  process.env.OLLAMA_MODEL          || "qwen2.5:32b",'
if old in src: src = src.replace(old, new, 1); results.append("CFG: OK")
else: results.append("CFG: NOT FOUND")

# 2. isEnCours grace 30j
old = '      const dStr     = m[3] + "-" + m[2] + "-" + m[1];\n      const todayStr = new Date().toISOString().slice(0, 10);\n      if (dStr < todayStr) return false;'
new = '      const dStr  = m[3] + "-" + m[2] + "-" + m[1];\n      const grace = new Date(); grace.setDate(grace.getDate() - 30);\n      if (dStr < grace.toISOString().slice(0, 10)) return false;'
if old in src: src = src.replace(old, new, 1); results.append("isEnCours: OK")
else: results.append("isEnCours: NOT FOUND")

