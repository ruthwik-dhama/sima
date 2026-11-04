import type { PlatformAdapter } from '@sima/adapter-core';
import { gradescopeAdapter } from '@sima/adapter-gradescope';
import { vhlAdapter } from '@sima/adapter-vhl';
import { webassignAdapter } from '@sima/adapter-webassign';

/** Adding a platform means writing an adapter, adding it here, and adding its host to the manifest. */
export const ADAPTERS: PlatformAdapter[] = [gradescopeAdapter, vhlAdapter, webassignAdapter];
