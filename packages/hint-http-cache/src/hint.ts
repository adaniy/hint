/**
 * @fileoverview Checks if your cache-control header and asset strategy follows best practices
 */

import { debug as d } from '@hint/utils/dist/src/debug';
import { isDataURI } from '@hint/utils/dist/src/network/is-data-uri';
import { normalizeHeaderValue } from '@hint/utils/dist/src/network/normalize-header-value';
import { IHint, FetchEnd } from 'hint/dist/src/lib/types';
import { HintContext } from 'hint/dist/src/lib/hint-context';

import meta from './meta';
import { getMessage } from './i18n.import';

const debug = d(__filename);

type TargetType = 'fetch' | 'html';
type Directives = Map<string, number | null>;
type ParsedDirectives = {
    header: string;
    invalidDirectives: Map<string, string | null>;
    invalidValues: Map<string, string>;
    usedDirectives: Directives;
};

export default class HttpCacheHint implements IHint {

    public static readonly meta = meta;

    public constructor(context: HintContext) {

        /**
         * Max time the HTML of a page can be cached.
         * https://jakearchibald.com/2016/caching-best-practices/#used-carefully-max-age-mutable-content-can-be-beneficial
         */
        const maxAgeTarget = context.hintOptions && context.hintOptions.maxAgeTarget || 180; // 3 minutes
        /** Max time a resource (CSS, JS, images, etc.) can be cached.*/
        const maxAgeResource = context.hintOptions && context.hintOptions.maxAgeResource || 31536000; // 1 year
        /** Resources' mediaType that should be cached for a long time.*/
        const longCached = [
            'application/manifest+json',

            'audio/ogg',
            'audio/mpeg',
            'audio/mp4',

            'font/collection',
            'application/vnd.ms-fontobject',
            'font/opentype',
            'font/otf',
            'font/ttf',
            'font/woff',
            'font/woff2',

            'image/bmp',
            'image/gif',
            'image/jpeg',
            'image/png',
            'image/svg+xml',
            'image/webp',
            'image/x-icon',

            'text/css',
            'text/javascript',

            'video/mp4',
            'video/ogg',
            'video/webm'];
        /** The predefined patterns for file revving.*/
        const predefinedRevvingPatterns: RegExp[] = [
            /*
             * E.g.: version/timestamp/hash
             *
             * Live example: https://regex101.com/r/KDPUtH/
             */

            /*
             * - https://example.com/assets/jquery-2.1.1.js
             * - https://example.com/assets/jquery-2.1.1.min.js
             * - https://example.com/assets/jquery-3.0.0-beta.js
             * - https://example.com/assets/favicon.123.ico
             * - https://example.com/wp-content/uploads/fvm/out/header-cb050ccd-1524626949.min.js
             */
            /\/[^/]+[._-]v?\d+(\.\d+(\.\d+)?)?[^/]*\.\w+$/i,

            /*
             * - https://cdn.example.com/jquery.lazy/1.6.5/jquery.lazy.min.js
             */
            /\/v?\d+\.\d+\.\d+.*?\//i,

            /*
             * - https://example.com/site/javascript/v5/jquery.cookie.js
             * - https://static.xx.fbcdn.net/rsrc.php/v3iJhv4/yG/l/en_US/sqNNamBywvN.js
             */
            /\/v\d.*?\//i,

            /*
             * - https://example.com/assets/unicorn-d41d8cd98f.css
             * - https://example.com/assets/app.e1c7a.bundle.js
             * - https://example.com/assets/9f61f58dd1cc3bb82182.bundle.js
             * - https://example.com/assets/9f61f.js
             * - https://example.com/assets/9f61f.min.js
             */
            /\/([^/]+[._-])?([0-9a-f]{5,})([._-].*?)?\.\w+$/i
        ];

        /** The cache revving patterns to use for matching.*/
        let cacheRevvingPatterns: RegExp[] = [];

        /**
         * Parses the `Cache-Control` header of a response creating an object with valid and invalid directives,
         * as well as invalid values.
         */
        const parseCacheControlHeader = (cacheControlHeader: string): ParsedDirectives => {
            // https://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html#sec14.9
            const directives = ['must-revalidate', 'no-cache', 'no-store', 'no-transform', 'public', 'private', 'proxy-revalidate'];
            const valueDirectives = ['max-age', 's-maxage'];
            const extensionDirectives = ['immutable', 'stale-while-revalidate', 'stale-if-error'];

            const usedDirectives = cacheControlHeader.split(',').map((value) => {
                return value.trim();
            });

            const parsedCacheControlHeader = usedDirectives.reduce((parsed: ParsedDirectives, current: string) => {
                const [directive, value] = current.split('=');

                // Validate directive with value. E.g.: max-age=<seconds>
                if (directive && value) {
                    /*
                     * Check if the directive has a value when it shouldn't
                     * E.g.: no-cache=12345
                     */
                    if (!valueDirectives.includes(directive)) {
                        parsed.invalidValues.set(directive, value);

                        return parsed;
                    }

                    /*
                     * Check if the directive has the right value (positive integer)
                     * E.g.: max-age=3600
                     */
                    const seconds = parseFloat(value);

                    if (!value || isNaN(seconds) || !Number.isInteger(seconds) || seconds < 0) {
                        parsed.invalidValues.set(directive, value);

                        return parsed;
                    }

                    parsed.usedDirectives.set(directive, seconds);

                    return parsed;
                }

                /*
                 * Check the directive is valid
                 * E.g.: no-cache
                 */
                if (directives.includes(directive) || extensionDirectives.includes(directive)) {
                    parsed.usedDirectives.set(directive, null);
                } else {
                    parsed.invalidDirectives.set(directive, null);
                }

                return parsed;
            },
            {
                header: cacheControlHeader,
                invalidDirectives: new Map(),
                invalidValues: new Map(),
                usedDirectives: new Map<string, number>()
            });

            return parsedCacheControlHeader;
        };

        /**
         * Transforms a Map of directives to a string with the following format:
         *
         * directive1=value1
         * directive2
         * diretive3=value3
         */
        const directivesToString = (directives: Map<string, any>) => {
            let str = '';

            directives.forEach((val, key) => {

                if (str.length > 0) {
                    str += '\n';
                }

                str += key;
                if (val) {
                    str += `=${val}`;
                }
            });

            return str;
        };

        /**
         * Compares if the `max-age` or `s-maxage` directives of `directives` are smaller (<0),
         * equal (0), or bigger (>0) than the given `threshold`.
         */
        const compareToMaxAge = (directives: Directives, threshold: number): number => {
            const maxAge = directives.get('max-age');
            const sMaxAge = directives.get('s-maxage');

            if (maxAge) {
                return maxAge === threshold ? 0 : maxAge - threshold;
            }

            if (sMaxAge) {
                return sMaxAge === threshold ? 0 : sMaxAge - threshold;
            }

            return -1;
        };

        /*
         * ------------------------------------------------------------------------------
         * Directive validators
         * ------------------------------------------------------------------------------
         */

        /**
         * Prevents agains the usage of non recommended directives (`must-revalidate`)
         */
        const nonRecommendedDirectives = (directives: Directives): string | null => {
            const noDirectives = ['must-revalidate', 'no-store'];

            for (const noDirective of noDirectives) {
                if (directives.has(noDirective)) {
                    return noDirective;
                }
            }

            return null;
        };

        /*
         * Validate if cache-control exists, not having this header is
         * an error because it's up to the browser vendor to decide what
         * to do.
         */
        const hasCacheControl = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { resource, response: { headers } } = fetchEnd;
            const cacheControl: string | null = headers && headers['cache-control'] || null;

            if (!cacheControl) {
                context.report(resource, getMessage('noHeaderFound', context.language));

                return false;
            }

            return true;
        };

        /*
         * Validates if all the cache-control directives and values are correct.
         */
        const hasInvalidDirectives = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { header, invalidDirectives, invalidValues } = directives;
            const { resource } = fetchEnd;
            const codeSnippet = `Cache-Control: ${header}`;
            const codeLanguage = 'http';

            if (invalidDirectives.size > 0) {
                const message: string = getMessage('directiveInvalid', context.language, [
                    invalidDirectives.size === 1 ? 'directive' : 'directives',
                    Array.from(invalidDirectives.keys()).join(', '),
                    invalidDirectives.size === 1 ? 'is' : 'are'
                ]);

                context.report(resource, message, { codeLanguage, codeSnippet });

                return false;
            }

            if (invalidValues.size > 0) {
                const message: string = getMessage('directiveInvalidValue', context.language, [
                    invalidValues.size === 1 ? 'directive has' : 'directives have',
                    directivesToString(invalidValues)
                ]);

                context.report(resource, message, { codeLanguage, codeSnippet });

                return false;
            }

            return true;
        };

        /*
         * Validates if there is any non recommended directives.
         */
        const hasNoneNonRecommendedDirectives = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { header, usedDirectives } = directives;
            const { resource } = fetchEnd;
            const nonRecommendedDirective = nonRecommendedDirectives(usedDirectives);

            if (nonRecommendedDirective) {
                const message: string = getMessage('directiveNotRecomended', context.language, nonRecommendedDirective);

                context.report(resource, message, { codeLanguage: 'http', codeSnippet: `Cache-Control: ${header}` });

                return false;
            }

            return true;
        };

        /**
         * Validates that `no-cache` and `no-store` are not used in combination
         *  with `max-age` or `s-maxage`.
         */
        const validateDirectiveCombinations = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { header, usedDirectives } = directives;

            if (usedDirectives.has('no-cache') || usedDirectives.has('no-store')) {
                const hasMaxAge = (usedDirectives.has('max-age') || usedDirectives.has('s-maxage'));

                if (hasMaxAge) {
                    const message: string = getMessage('wrongCombination', context.language, header);

                    context.report(fetchEnd.resource, message, { codeLanguage: 'http', codeSnippet: `Cache-Control: ${header}` });

                    return false;
                }
            }

            return true;
        };

        /**
         * Validates the target uses no-cache or a small max-age value
         */
        const hasSmallCache = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { header, usedDirectives } = directives;

            if (usedDirectives.has('no-cache')) {
                return true;
            }

            const isValidCache = compareToMaxAge(usedDirectives, maxAgeTarget) <= 0;

            if (!isValidCache) {
                const message: string = getMessage('targetShouldNotBeCached', context.language, [maxAgeTarget, header]);

                context.report(fetchEnd.resource, message, { codeLanguage: 'http', codeSnippet: `Cache-Control')}: ${header}` });

                return false;
            }

            return true;
        };

        /**
         * Validates that a resource (JS, CSS, images, etc.) has the right caching directives.
         */
        const hasLongCache = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { header, usedDirectives } = directives;
            const { resource } = fetchEnd;
            const codeSnippet = `Cache-Control: ${header}`;
            const codeLanguage = 'http';

            const longCache = compareToMaxAge(usedDirectives, maxAgeResource) >= 0;
            const immutable = usedDirectives.has('immutable');
            let validates = true;

            // We want long caches with "immutable" for static resources
            if (usedDirectives.has('no-cache') || !longCache) {
                const message: string = getMessage('staticResourceCacheValue', context.language, [maxAgeResource, header]);

                context.report(resource, message, { codeLanguage, codeSnippet });

                validates = false;
            }

            if (!immutable) {
                const message: string = getMessage('staticNotImmutable', context.language, header);

                context.report(resource, message, { codeLanguage, codeSnippet });

                validates = false;
            }

            return validates;
        };

        /**
         * Validates that a resource (JS, CSS, images, etc.) is using the right file revving format.
         */
        const usesFileRevving = (directives: ParsedDirectives, fetchEnd: FetchEnd): boolean => {
            const { element, resource } = fetchEnd;
            const matches = cacheRevvingPatterns.find((pattern) => {
                return !!resource.match(pattern);
            });

            if (!matches) {
                const message: string = getMessage('noCacheBustingPattern', context.language, resource);

                context.report(resource, message, { element });

                return false;
            }

            return true;
        };

        const validate = (fetchEnd: FetchEnd, eventName: string) => {
            const type: TargetType = eventName === 'fetch::end::html' ? 'html' : 'fetch';
            const { resource } = fetchEnd;

            // This check does not make sense for data URIs.

            if (isDataURI(resource)) {
                debug(`Check does not apply for data URIs`);

                return;
            }

            const headers = fetchEnd.response.headers;
            const { response: { mediaType } } = fetchEnd;
            const cacheControlHeaderValue: string = normalizeHeaderValue(headers, 'cache-control', '')!; // won't return null since default value was provided
            const parsedDirectives: ParsedDirectives = parseCacheControlHeader(cacheControlHeaderValue);

            const validators = [
                hasCacheControl,
                hasInvalidDirectives,
                hasNoneNonRecommendedDirectives,
                validateDirectiveCombinations
            ];

            if (type === 'html') {
                validators.push(hasSmallCache);
            } else if (type === 'fetch' && longCached.includes(mediaType)) {
                validators.push(hasLongCache);

                // Check if there are custom revving patterns
                let customRegex: RegExp[] | null = context.hintOptions && context.hintOptions.revvingPatterns || null;

                if (customRegex) {
                    customRegex = customRegex.map((reg) => {
                        return new RegExp(reg, 'i');
                    });
                }

                cacheRevvingPatterns = customRegex || predefinedRevvingPatterns;

                validators.push(usesFileRevving);
            }

            validators.every((validator) => {
                return validator(parsedDirectives, fetchEnd);
            });

            return;
        };

        context.on('fetch::end::*', validate);
    }
}
