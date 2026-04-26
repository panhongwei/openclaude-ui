// Entry for browser-bundled renderer libs (bun build → iife)
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';

globalThis.hljs   = hljs;
globalThis.marked = marked;
