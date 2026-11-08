import {escape as e} from './model.js';

export function googleMapsUrl(location) {
  const query=String(location??'').trim();
  if(!query)return '';
  const url=new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api','1');url.searchParams.set('query',query);
  return url.href.length<=2048?url.href:'';
}

export function mapLink(location,{label,fallback='地點待確認'}={}) {
  const url=googleMapsUrl(location),text=label??String(location??'').trim();
  if(!url)return e(text||fallback);
  return `<a class="map-link" href="${e(url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(`在 Google Maps 開啟 ${text}（另開分頁）`)}" title="在 Google Maps 開啟（另開分頁）">${e(text)}<svg class="map-link-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg></a>`;
}
