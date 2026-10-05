import { describe, expect, test } from 'bun:test';
import { mergeEditFiles } from './runner';

describe('mergeEditFiles', () => {
  test('projet complet = base + modifications (les modifs gagnent, les nouveaux fichiers sont ajoutés)', () => {
    const all = [
      { path: 'package.json', content: '{}' },
      { path: 'src/lib/auth.tsx', content: 'auth' },
      { path: 'src/pages/Home.tsx', content: 'old' },
    ];
    const out = mergeEditFiles(all, [
      { path: 'src/pages/Home.tsx', content: 'new' },
      { path: 'src/pages/Blog.tsx', content: 'blog' },
    ]);
    const m = new Map(out.map((f) => [f.path, f.content]));
    expect(out.length).toBe(4);
    expect(m.get('package.json')).toBe('{}');
    expect(m.get('src/lib/auth.tsx')).toBe('auth');
    expect(m.get('src/pages/Home.tsx')).toBe('new');
    expect(m.get('src/pages/Blog.tsx')).toBe('blog');
  });
});
