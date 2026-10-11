import type { ProjectCommand } from '../../core/commands';
import type { Channel, Project } from '../../core/project/model';
import { PanelFrame } from '../../components/PanelFrame';
import { ChannelInspector } from './ChannelInspector';
import { SampleLibrary, type LibraryNotice } from './SampleLibrary';

interface BrowserPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  project: Project;
  activeChannel: Channel | null;
  isAssetLoaded: (assetId: string) => boolean;
  busy: boolean;
  notice: LibraryNotice | null;
  onDismissNotice: () => void;
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  onImportFiles: (files: File[]) => void;
  onLoadStarterPack: () => void;
  onPreviewAsset: (assetId: string) => void;
  onAssignAsset: (channelId: string, assetId: string) => void;
  onPreviewChannel: (channelId: string) => void;
  onAuditionSynth: (channelId: string) => void;
  onError: (message: string) => void;
}

export function BrowserPanel({
  collapsed,
  onToggle,
  project,
  activeChannel,
  isAssetLoaded,
  busy,
  notice,
  onDismissNotice,
  onCommand,
  onImportFiles,
  onLoadStarterPack,
  onPreviewAsset,
  onAssignAsset,
  onPreviewChannel,
  onAuditionSynth,
  onError,
}: BrowserPanelProps) {
  return (
    <aside className={`browser-aside ${collapsed ? 'browser-aside--collapsed' : ''}`}>
      <PanelFrame
        badge="LIBRARY"
        className="browser-panel"
        collapsed={collapsed}
        id="panel-browser"
        onToggle={onToggle}
        title="Browser"
      >
        <div className="browser-content">
          <SampleLibrary
            activeChannel={activeChannel}
            assets={project.audioAssets}
            busy={busy}
            isLoaded={isAssetLoaded}
            notice={notice}
            onAssignAsset={onAssignAsset}
            onDismissNotice={onDismissNotice}
            onImportFiles={onImportFiles}
            onLoadStarterPack={onLoadStarterPack}
            onPreviewAsset={onPreviewAsset}
          />
          <ChannelInspector
            assets={project.audioAssets}
            channel={activeChannel}
            isAssetLoaded={isAssetLoaded}
            onAuditionSynth={onAuditionSynth}
            onCommand={onCommand}
            onError={onError}
            onPreviewChannel={onPreviewChannel}
          />
        </div>
      </PanelFrame>
    </aside>
  );
}
