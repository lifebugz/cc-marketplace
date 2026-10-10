---
type: regex
target: { source: file, path: .env }
pattern: 'SESSION_SECRET=\S{16,}'
---
