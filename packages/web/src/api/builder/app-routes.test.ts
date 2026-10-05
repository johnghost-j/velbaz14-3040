import { describe, expect, test } from 'bun:test';
import { appTsxWithNewRoutes, pageComponent, wireNewRoutes } from './app-routes';
import { buildAppTsx } from './engine';

const APP = `import { Routes, Route } from "react-router-dom";
import {
  useEffect,
  useState,
} from "react";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import LegalNotice from "./pages/LegalNotice";
import NotFound from "./pages/NotFound";
import ProductDetail from "./pages/ProductDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/product/:id" element={<ProductDetail />} />
        <Route path="/legal-notice" element={<LegalNotice />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
`;

describe('wireNewRoutes', () => {
  test('ajoute import + route avant le catch-all, sans toucher aux routes existantes', () => {
    const out = wireNewRoutes(APP, [
      { name: 'Blog', route: '/blog', file: 'Blog.tsx' },
      { name: 'BlogPost', route: '/blog/:slug', file: 'src/pages/BlogPost.tsx' },
    ])!;
    expect(out).toContain('<Route path="/" element={<Home />} />');
    expect(out).toContain('<Route path="/product/:id" element={<ProductDetail />} />');
    expect(out).toContain('import Blog from "./pages/Blog";');
    expect(out).toContain('import BlogPost from "./pages/BlogPost";');
    expect(out.indexOf('path="/blog"')).toBeLessThan(out.indexOf('path="*"'));
    expect(out.indexOf('path="/blog/:slug"')).toBeLessThan(out.indexOf('path="*"'));
    expect(out).toContain('        <Route path="/blog" element={<Blog />} />\n');
    // import ajouté APRÈS le dernier import, jamais au milieu de l'import multi-ligne
    expect(out).toContain('} from "react";\nimport Layout');
    expect(out.indexOf('import Blog ')).toBeGreaterThan(out.indexOf('import ProductDetail'));
    expect(out.match(/import LegalNotice/g)!.length).toBe(1);
  });

  test('idempotent : route déjà là → rien ne change ; /blog/:slug ne masque pas /blog', () => {
    const once = wireNewRoutes(APP, [{ route: '/blog/:slug', file: 'BlogPost.tsx' }])!;
    const twice = wireNewRoutes(once, [{ route: '/blog/:slug', file: 'BlogPost.tsx' }])!;
    expect(twice).toBe(once);
    const withBlog = wireNewRoutes(once, [{ route: '/blog', file: 'Blog.tsx' }])!;
    expect(withBlog).toContain('path="/blog" element={<Blog />}');
    expect(wireNewRoutes(APP, [{ route: '/', file: 'Landing.tsx' }])).toBe(APP);
  });

  test('page jamais écrite → pas de route morte ; entrées invalides ignorées', () => {
    const out = wireNewRoutes(APP, [{ route: '/faq', file: 'Faq.tsx' }], ['src/pages/Home.tsx'])!;
    expect(out).toBe(APP);
    expect(wireNewRoutes(APP, [{ route: 'javascript:alert(1)', file: 'X.tsx' }, { route: '/x' }])).toBe(APP);
  });

  test('sans <Routes> → null (régénération)', () => {
    expect(wireNewRoutes('export default () => null;', [{ route: '/a', file: 'A.tsx' }])).toBeNull();
  });

  test('pageComponent', () => {
    expect(pageComponent({ file: 'src/pages/blog-post.tsx' })).toBe('Blogpost');
    expect(pageComponent({ name: 'Faq' })).toBe('Faq');
    expect(pageComponent({ file: '123.tsx' })).toBeNull();
  });
});

describe('appTsxWithNewRoutes', () => {
  test('part de l\'App.tsx modifié par l\'édition s\'il existe, et connaît les pages créées', () => {
    const files = [{ path: 'src/App.tsx', content: APP }, { path: 'src/pages/Home.tsx', content: '' }];
    const changed = [{ path: 'src/pages/Blog.tsx', content: 'x' }];
    const out = appTsxWithNewRoutes(files, changed, [{ route: '/blog', file: 'Blog.tsx' }])!;
    expect(out).toContain('path="/blog"');
    expect(out).toContain('path="/"');
    expect(appTsxWithNewRoutes([], [], [{ route: '/blog', file: 'Blog.tsx' }])).toBeNull();
  });
});

describe('buildAppTsx (secours) — jamais de double import', () => {
  test('pages standard présentes dans la liste → importées une seule fois', () => {
    const app = buildAppTsx([
      { name: 'Home', file: 'Home.tsx', route: '/' },
      { name: 'LegalNotice', file: 'LegalNotice.tsx', route: '/legalnotice' },
      { name: 'NotFound', file: 'NotFound.tsx', route: '/notfound' },
      { name: 'Login', file: 'Login.tsx', route: '/login' },
      { name: 'Home', file: 'Home.tsx', route: '/home' },
    ], false);
    for (const c of ['LegalNotice', 'NotFound', 'Login', 'Home']) {
      expect(app.match(new RegExp(`import ${c} from`, 'g'))!.length).toBe(1);
    }
  });
});
