/**
 * @fileoverview Check if a single web app manifest file is specified,
 * and if that specified file is accessible.
 */

/*
 * ------------------------------------------------------------------------------
 * Requirements
 * ------------------------------------------------------------------------------
 */

import {
    ElementFound,
    FetchError,
    HintContext,
    IHint,
    ScanEnd
} from 'hint';
import { misc } from '@hint/utils';
import { ManifestEvents } from '@hint/parser-manifest';

import meta from './meta';
import { getMessage } from './i18n.import';

const { normalizeString } = misc;
/*
 * ------------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------------
 */

export default class ManifestExistsHint implements IHint {

    public static readonly meta = meta;

    public constructor(context: HintContext<ManifestEvents>) {

        let manifestIsSpecified = false;

        const checkIfManifestWasSpecified = (scanEndEvent: ScanEnd) => {
            if (!manifestIsSpecified) {
                context.report(scanEndEvent.resource, getMessage('manifestNotSpecified', context.language));
            }
        };

        const checkIfManifest = (data: ElementFound) => {
            const { element, resource } = data;

            if (normalizeString(element.getAttribute('rel')) !== 'manifest') {
                return;
            }

            /*
             * Check if we encounter more than one
             * <link rel="manifest"...> declaration.
             */

            if (manifestIsSpecified) {
                context.report(resource, getMessage('manifestDuplicated', context.language), { element });

                return;
            }

            manifestIsSpecified = true;

            const href = normalizeString(element.getAttribute('href'));

            if (!href) {
                context.report(resource, getMessage('manifestNonEmptyHref', context.language), { element });
            }
        };

        const handleFetchErrors = (fetchErrorEvent: FetchError) => {
            const { resource, element, error } = fetchErrorEvent;

            context.report(resource, error.message, { element });
        };

        context.on('element::link', checkIfManifest);
        context.on('fetch::error::manifest', handleFetchErrors);
        context.on('scan::end', checkIfManifestWasSpecified);
    }
}
