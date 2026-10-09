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

  it('exposes the transport controls backed by the audio engine', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('LOOP');
    expect(markup).toContain('Seek within the region');
    expect(markup).toContain('Play a test tone');
    expect(markup).toContain('Enable audio');
    expect(markup).toContain('Pattern editing active · scheduled audio engine online');
  });
});
