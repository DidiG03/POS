import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

function setMeta(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setProperty(property: string, content: string) {
  let el = document.querySelector(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('property', property);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/** Keeps the document title and description in sync with the current screen. */
export function DocumentMeta({ title }: { title?: string }) {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const product = t('brand.product');
    const description = t('seo.description');
    document.title = title ? `${title} · ${product}` : product;
    setMeta('description', description);
    setProperty('og:title', document.title);
    setProperty('og:description', description);
  }, [title, t, i18n.language]);

  return null;
}
