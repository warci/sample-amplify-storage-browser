import {
  createAmplifyAuthAdapter,
  createStorageBrowser,
  defaultActionConfigs,
} from '@aws-amplify/ui-react-storage/browser';
import type {
  DownloadHandlerInput,
  DownloadHandlerOutput,
} from '@aws-amplify/ui-react-storage/browser';
import '@aws-amplify/ui-react-storage/styles.css';
import './App.css';

import config from '../amplify_outputs.json';
import { Amplify } from 'aws-amplify';
import { Authenticator, Button } from '@aws-amplify/ui-react';
import { getUrl as getStorageUrl } from '@aws-amplify/storage/internals';
import { getUrl as getPublicUrl } from 'aws-amplify/storage';
import JSZip from 'jszip';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
Amplify.configure(config);

type DownloadTaskResult =
  DownloadHandlerOutput['result'] extends Promise<infer R> ? R : never;

interface DownloadBatchState {
  keys: string[];
  promise?: Promise<DownloadTaskResult>;
}

let downloadBatch: DownloadBatchState | null = null;

const triggerDownload = (fileName: string, url: string) => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

const getFileName = (key: string) => {
  const segments = key.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? key;
};

const areKeysEqual = (first: string[], second: string[]) => {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((key, index) => key === second[index]);
};

const setDownloadBatchKeys = (keys: string[]) => {
  if (!keys.length) {
    downloadBatch = null;
    return;
  }

  if (downloadBatch && areKeysEqual(downloadBatch.keys, keys)) {
    return;
  }

  downloadBatch = { keys: [...keys] };
};

const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.svg',
];

const isImageFileKey = (key: string) => {
  const lowerKey = key.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lowerKey.endsWith(ext));
};

const useThumbnailUrls = (files: FileItem[] | undefined) => {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const keys = useMemo(() => files?.map((file) => file.key) ?? [], [files]);
  const signature = useMemo(() => keys.join('|'), [keys]);

  useEffect(() => {
    if (!signature) {
      setUrls({});
      return;
    }

    let isMounted = true;
    const load = async () => {
      const entries = await Promise.all(
        signature.split('|').map(async (key) => {
          if (!isImageFileKey(key)) {
            return [key, null] as const;
          }
          try {
            const { url } = await getPublicUrl({
              path: key,
              options: {
                validateObjectExistence: false,
                expiresIn: 300,
              },
            });
            return [key, url.toString()] as const;
          } catch {
            return [key, null] as const;
          }
        }),
      );
      if (!isMounted) {
        return;
      }
      setUrls((prev) => {
        const next = Object.fromEntries(entries);
        const changed =
          Object.keys(next).length !== Object.keys(prev).length ||
          Object.entries(next).some(([key, value]) => prev[key] !== value);
        return changed ? next : prev;
      });
    };

    load();
    return () => {
      isMounted = false;
    };
  }, [signature]);

  return urls;
};

const createBucketInput = (config: DownloadHandlerInput['config']) => ({
  bucketName: config.bucket,
  region: config.region,
});

const getPresignedDownloadUrl = async (
  config: DownloadHandlerInput['config'],
  key: string,
) => {
  const { accountId, credentials, customEndpoint } = config;
  const { url } = await getStorageUrl({
    path: key,
    options: {
      bucket: createBucketInput(config),
      customEndpoint,
      locationCredentialsProvider: credentials,
      validateObjectExistence: true,
      contentDisposition: 'attachment',
      expectedBucketOwner: accountId,
    },
  });

  return url;
};

const triggerBlobDownload = (fileName: string, blob: Blob) => {
  const blobUrl = URL.createObjectURL(blob);
  triggerDownload(fileName, blobUrl);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  return blobUrl;
};

const createArchiveName = (keys: string[]) => {
  const firstName = getFileName(keys[0] ?? 'storage-download');
  const suffix = keys.length > 1 ? `-${keys.length}-files` : '';
  return `${firstName}${suffix}-${Date.now()}.zip`;
};

const downloadAsArchive = async (
  config: DownloadHandlerInput['config'],
  keys: string[],
): Promise<DownloadTaskResult> => {
  const zip = new JSZip();
  for (const key of keys) {
    const url = await getPresignedDownloadUrl(config, key);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to download ${key}`);
    }
    const blob = await response.blob();
    zip.file(key, blob);
  }

  const archiveBlob = await zip.generateAsync({ type: 'blob' });
  const blobUrl = triggerBlobDownload(createArchiveName(keys), archiveBlob);
  return { status: 'COMPLETE' as const, value: { url: new URL(blobUrl) } };
};

const downloadSingleFile = async (
  config: DownloadHandlerInput['config'],
  key: string,
): Promise<DownloadTaskResult> => {
  const url = await getPresignedDownloadUrl(config, key);
  triggerDownload(getFileName(key), url.toString());
  return { status: 'COMPLETE' as const, value: { url } };
};

const downloadHandler = ({
  config,
  data: { key },
}: DownloadHandlerInput): DownloadHandlerOutput => {
  const batch = downloadBatch;

  if (!batch || batch.keys.length <= 1 || !batch.keys.includes(key)) {
    return {
      result: downloadSingleFile(config, key).catch((error: Error) => {
        const { message } = error;
        return { error, message, status: 'FAILED' as const };
      }),
    };
  }

  if (!batch.promise) {
    batch.promise = downloadAsArchive(config, batch.keys)
      .catch((error: Error) => {
        downloadBatch = null;
        throw error;
      })
      .finally(() => {
        downloadBatch = null;
      });
  }

  return { result: batch.promise };
};

const {
  StorageBrowser,
  useView,
} = createStorageBrowser({
  config: createAmplifyAuthAdapter(),
  actions: {
    default: {
      download: {
        ...defaultActionConfigs.download,
        handler: downloadHandler,
      },
    },
  },
});

const DefaultDownloadView = StorageBrowser.DownloadView;

type DefaultDownloadViewProps = ComponentProps<typeof DefaultDownloadView>;

const DownloadViewBridge = (props: DefaultDownloadViewProps) => {
  const { tasks = [] } = useView('Download');

  useEffect(() => {
    const keys = tasks
      .map((task) => task.data?.key)
      .filter((value): value is string => typeof value === 'string');
    setDownloadBatchKeys(keys);
  }, [tasks]);

  useEffect(
    () => () => {
      setDownloadBatchKeys([]);
    },
    [],
  );

  return <DefaultDownloadView {...props} />;
};

type StorageBrowserItem = {
  id: string;
  key: string;
  type: 'FILE' | 'FOLDER';
  [key: string]: unknown;
};

type FolderItem = StorageBrowserItem & { type: 'FOLDER' };
type FileItem = StorageBrowserItem & { type: 'FILE' };

interface GalleryGridProps {
  folders: FolderItem[];
  files: FileItem[];
  thumbnails: Record<string, string | null>;
  selectedIds: Set<string>;
  activeFileId?: string;
  onOpenFolder: (folder: FolderItem) => void;
  onPreviewFile: (file: FileItem) => void;
  onToggleSelection: (file: FileItem) => void;
  onDownloadFile: (file: FileItem) => void;
}

const GalleryGrid = ({
  folders,
  files,
  thumbnails,
  selectedIds,
  activeFileId,
  onOpenFolder,
  onPreviewFile,
  onToggleSelection,
  onDownloadFile,
}: GalleryGridProps) => {
  if (!folders.length && !files.length) {
    return (
      <p className="storage-gallery-grid__empty">
        No items in this location.
      </p>
    );
  }

  return (
    <div className="storage-gallery-grid">
      {folders.map((folder) => (
        <button
          key={folder.id}
          className="storage-gallery-card storage-gallery-card--folder"
          type="button"
          onClick={() => onOpenFolder(folder)}
        >
          <div className="storage-gallery-card__thumb">
            <span aria-hidden={true}>📁</span>
          </div>
          <div className="storage-gallery-card__meta">
            <span className="storage-gallery-card__name">
              {getFileName(folder.key)}
            </span>
            <span className="storage-gallery-card__detail">Folder</span>
          </div>
        </button>
      ))}
      {files.map((file) => {
        const thumbnail = thumbnails[file.key];
        const isSelected = selectedIds.has(file.id);
        const isActive = activeFileId === file.id;
        return (
          <div
            key={file.id}
            className={`storage-gallery-card storage-gallery-card--file${
              isActive ? ' is-active' : ''
            }`}
          >
            <button
              type="button"
              className="storage-gallery-card__select"
              aria-pressed={isSelected}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSelection(file);
              }}
            >
              <input type="checkbox" readOnly checked={isSelected} />
              <span>{isSelected ? 'Selected' : 'Select'}</span>
            </button>
            <button
              type="button"
              className="storage-gallery-card__thumb"
              onClick={() => onPreviewFile(file)}
            >
              {thumbnail ? (
                <img src={thumbnail} alt={getFileName(file.key)} />
              ) : (
                <span className="storage-gallery-card__placeholder">
                  {isImageFileKey(file.key) ? 'Preview loading…' : 'No preview'}
                </span>
              )}
            </button>
            <div className="storage-gallery-card__meta">
              <span className="storage-gallery-card__name">
                {getFileName(file.key)}
              </span>
              <span className="storage-gallery-card__detail">File</span>
            </div>
            <button
              type="button"
              className="storage-gallery-card__download"
              onClick={(event) => {
                event.stopPropagation();
                onDownloadFile(file);
              }}
            >
              Download
            </button>
          </div>
        );
      })}
    </div>
  );
};

const DefaultLocationDetailView = StorageBrowser.LocationDetailView;

type DefaultLocationDetailViewProps = ComponentProps<
  typeof DefaultLocationDetailView
>;

const GalleryLocationDetailView = ({
  className,
  children,
  onSignOut,
}: DefaultLocationDetailViewProps & { onSignOut?: () => void }) => {
  const state = useView('LocationDetail');
  const {
    pageItems,
    fileDataItems,
    location,
    onNavigate,
    onSelectActiveFile,
    onSelect,
    onDownload,
    onToggleSelectAll,
    hasError,
  } = state;
  const folders = useMemo(
    () =>
      pageItems.filter((item) => item.type === 'FOLDER') as unknown as FolderItem[],
    [pageItems],
  );
  const files = useMemo(
    () =>
      pageItems.filter((item) => item.type === 'FILE') as unknown as FileItem[],
    [pageItems],
  );
  const thumbnails = useThumbnailUrls(files);
  const selectedIds = useMemo(
    () => new Set(fileDataItems?.map((item) => item.id)),
    [fileDataItems],
  );

  const handleFolderOpen = (folder: FolderItem) => {
    if (!location.current) {
      return;
    }
    const basePrefix = location.current.prefix ?? '';
    const relativePath = folder.key.slice(basePrefix.length);
    onNavigate(location.current, relativePath);
  };

  const handleSelectionToggle = (file: FileItem) => {
    onSelect(selectedIds.has(file.id), file as any);
  };

  const handlePreviewFile = (file: FileItem) => {
    onSelectActiveFile(file as any);
  };

  const handleDownloadFile = (file: FileItem) => {
    onDownload(file as any);
  };

  const composedClassName = [
    'amplify-storage-browser',
    'storage-gallery-view',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={composedClassName} data-testid="LOCATION_DETAIL_VIEW">
      <DefaultLocationDetailView.Provider {...state}>
        <DefaultLocationDetailView.Navigation />
        <div className="amplify-storage-browser__controls storage-gallery-view__controls">
          {onSignOut ? (
            <Button
              className="storage-gallery-view__sign-out"
              size="small"
              onClick={onSignOut}
            >
              Sign out
            </Button>
          ) : null}
          <div className="amplify-storage-browser__search storage-gallery-view__search">
            <DefaultLocationDetailView.Search />
            <DefaultLocationDetailView.SearchSubfoldersToggle />
          </div>
          <DefaultLocationDetailView.Pagination />
          <DefaultLocationDetailView.Refresh />
          <DefaultLocationDetailView.ActionsList />
        </div>
        <div className="storage-gallery-view__select-all-wrapper">
          <button
            type="button"
            className="storage-gallery-view__select-all"
            onClick={onToggleSelectAll}
          >
            Select all
          </button>
        </div>
        {!hasError && (
          <div className="amplify-storage-browser__content-with-preview storage-gallery-view__content">
            <DefaultLocationDetailView.DropZone>
              <div className="amplify-storage-browser__data-table storage-gallery-view__grid">
                <DefaultLocationDetailView.LoadingIndicator />
                <GalleryGrid
                  folders={folders}
                  files={files}
                  thumbnails={thumbnails}
                  selectedIds={selectedIds}
                  activeFileId={state.activeFile?.id}
                  onOpenFolder={handleFolderOpen}
                  onPreviewFile={handlePreviewFile}
                  onToggleSelection={handleSelectionToggle}
                  onDownloadFile={handleDownloadFile}
                />
              </div>
            </DefaultLocationDetailView.DropZone>
            <DefaultLocationDetailView.FilePreview />
          </div>
        )}
        <div className="amplify-storage-browser__footer">
          <DefaultLocationDetailView.Message />
        </div>
        {children}
      </DefaultLocationDetailView.Provider>
    </div>
  );
};

const DefaultLocationsView = StorageBrowser.LocationsView;

type DefaultLocationsViewProps = ComponentProps<typeof DefaultLocationsView>;

const LocationsViewWithSignOut = ({
  className,
  onSignOut,
  ...rest
}: DefaultLocationsViewProps & { onSignOut?: () => void }) => {
  const state = useView('Locations');
  const composedClassName = [
    'amplify-storage-browser',
    'storage-locations-view',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={composedClassName} data-testid="LOCATIONS_VIEW">
      <DefaultLocationsView.Provider {...state} {...rest}>
        <div className="amplify-storage-browser__controls storage-gallery-view__controls">
          {onSignOut ? (
            <Button
              className="storage-gallery-view__sign-out"
              size="small"
              onClick={onSignOut}
            >
              Sign out
            </Button>
          ) : null}
          <div className="amplify-storage-browser__search storage-gallery-view__search">
            <DefaultLocationsView.Search />
          </div>
          <DefaultLocationsView.Pagination />
          <DefaultLocationsView.Refresh />
        </div>
        <div className="storage-locations-view__content">
          <DefaultLocationsView.LoadingIndicator />
          <DefaultLocationsView.LocationsTable />
        </div>
        <DefaultLocationsView.Message />
      </DefaultLocationsView.Provider>
    </div>
  );
};

function App() {
  return (
    <Authenticator>
      {({ signOut }) => (
        <StorageBrowser
          views={{
            DownloadView: DownloadViewBridge,
            LocationDetailView: (props) => (
              <GalleryLocationDetailView {...props} onSignOut={signOut} />
            ),
            LocationsView: (props) => (
              <LocationsViewWithSignOut {...props} onSignOut={signOut} />
            ),
          }}
        />
      )}
    </Authenticator>
  );
}

export default App;
