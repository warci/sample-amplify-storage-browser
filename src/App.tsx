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
import JSZip from 'jszip';
import { useEffect, type ComponentProps } from 'react';
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

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <>
          <div className="header">
            <h1>{`Hello ${user?.username}`}</h1>
            <Button onClick={signOut}>Sign out</Button>
          </div>
          <StorageBrowser views={{ DownloadView: DownloadViewBridge }} />
        </>
      )}
    </Authenticator>
  );
}

export default App;
