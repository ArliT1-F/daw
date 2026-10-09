import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('studio workspace shell', () => {
  it('renders all six foundation workspace areas', () => {
    const markup = renderToStaticMarkup(<App />);

    for (const panel of ['Channel Rack', 'Piano Roll', 'Playlist', 'Mixer', 'Browser']) {
      expect(markup).toContain(panel);
    }
    expect(markup).toContain('Transport controls');
    expect(markup).toContain('Master level meter unavailable');
  });
});
