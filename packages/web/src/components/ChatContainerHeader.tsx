import { useTheme } from '@/hooks/useTheme';
import { useCatData } from '@/hooks/useCatData';
import { HubButton } from './HubButton';

interface ChatContainerHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  threadId: string;
  authPendingCount: number;
  targetCats: string[];
  viewMode: 'single' | 'split';
  onToggleViewMode: () => void;
  onOpenMobileStatus: () => void;
  /** F092: Default cat for voice companion */
  defaultCatId: string;
}

export function ChatContainerHeader({
  // Sidebar toggle icon hidden by design; keep props for compatibility.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sidebarOpen: _sidebarOpen,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onToggleSidebar: _onToggleSidebar,
  // Header title/indicator removed by design; keep props for compatibility.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  threadId: _threadId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  authPendingCount: _authPendingCount,
  targetCats,
  // F099/OQ-4: viewMode toggle hidden - candidate for removal (KD-7)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewMode: _viewMode,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onToggleViewMode: _onToggleViewMode,
  onOpenMobileStatus,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  defaultCatId: _defaultCatId,
}: ChatContainerHeaderProps) {
  const { theme, toggleTheme } = useTheme();
  const { getCatById } = useCatData();
  const visibleCats = targetCats.map((id) => ({ id, cat: getCatById(id) })).filter((entry) => !!entry.cat);

  return (
    <header className="safe-area-top relative h-0 overflow-visible">
      <div className="absolute right-5 top-2 z-20 flex items-center gap-1">
        {visibleCats.length > 0 && (
          <div className="mr-2 hidden items-center gap-2 md:flex">
            {visibleCats.map(({ id, cat }) => (
              <div key={id} className="flex items-center gap-2" title={cat!.displayName}>
                <img src={cat!.avatar} alt={cat!.displayName} className="h-6 w-6 rounded-full" />
                <span className="text-sm text-[#191919]">{cat!.displayName}</span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onOpenMobileStatus}
          className="ui-icon-button lg:hidden"
          title="状态面板"
          aria-label="状态面板"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div className="flex items-center gap-1">
          <HubButton />
          <button
            type="button"
            onClick={toggleTheme}
            className="ui-icon-button"
            title={theme === 'warm' ? '切换到商务主题' : '切换到暖色主题'}
            aria-label={theme === 'warm' ? 'Switch to business theme' : 'Switch to warm theme'}
          >
            {theme === 'warm' ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 11h6M9 15h6M9 7h6" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <path d="M2 17h20" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
