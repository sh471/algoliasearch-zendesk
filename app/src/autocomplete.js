import { version } from '../package.json';
import algoliasearch from 'algoliasearch/lite';
import { autocomplete, getAlgoliaHits } from '@algolia/autocomplete-js';
import '@algolia/autocomplete-theme-classic';
import './autocomplete.css';
// eslint-disable-next-line no-unused-vars
import { render, h, Fragment } from 'preact';
import { groupBy } from 'lodash';

import translate from './translations';
import { debounceGetAnswers } from './answers';
import { initInsights, extendWithConversionTracking } from './clickAnalytics';

import {
  createLocalStorageRecentSearchesPlugin,
  search as defaultLocalStorageSearch,
} from '@algolia/autocomplete-plugin-recent-searches';

class Autocomplete {
  constructor({
    applicationId,
    apiKey,
    autocomplete: { enabled },
    indexPrefix,
    subdomain,
    clickAnalytics,
  }) {
    if (!enabled) return;
    this.client = algoliasearch(applicationId, apiKey);
    this.client.addAlgoliaAgent(`Zendesk Integration (${version})`);
    this.indexName = `${indexPrefix}${subdomain}_articles`;

    if (clickAnalytics) {
      initInsights({ applicationId, apiKey });
      extendWithConversionTracking(this, {
        clickAnalytics,
        indexName: this.indexName,
      });
    }
  }

  init({
    analytics,
    autocomplete: {
      enabled,
      bestArticle,
      hitsPerPage,
      inputSelector,
      keyboardShortcut,
    },
    baseUrl,
    color,
    clickAnalytics,
    debug,
    locale,
    highlightColor,
    poweredBy,
    subdomain,
    templates,
    translations,
  }) {
    if (!enabled) return;

    this.state = { isOpen: false };

    const doc = document.documentElement;
    doc.style.setProperty('--aa-primary-color', color);
    doc.style.setProperty('--aa-highlight-color', highlightColor);
    doc.style.setProperty('--aa-detached-modal-max-width', '680px');
    doc.style.setProperty('--aa-detached-modal-max-height', '80%');

    const defaultParams = {
      analytics,
      hitsPerPage,
      facetFilters: `["locale.locale:${locale}"]`,
      attributesToSnippet: ['body_safe:30'],
      snippetEllipsisText: '…',
    };

    const answersRef = {
      current: [],
    };
    const lang = locale.split('-')[0];

    // figure out parent container of the input
    const allInputs = document.querySelectorAll(inputSelector);
    if (allInputs.length === 0) {
      throw new Error(
        `Couldn't find any input matching inputSelector '${inputSelector}'.`
      );
    }
    if (allInputs.length > 1) {
      throw new Error(
        `Too many inputs (${allInputs.length}) matching inputSelector '${inputSelector}'.`
      );
    }
    let form = allInputs[0];
    while (form && form.tagName !== 'FORM') {
      form = form.parentElement;
    }
    if (!form) {
      throw new Error(
        `Couldn't find the parent container of inputSelector '${inputSelector}'`
      );
    }
    const container = document.createElement('div');
    container.className = form.className;
    form.parentNode.replaceChild(container, form);

    const buildUrl = (hit) => `${baseUrl}${locale}/articles/${hit.id}`;

    const onSelect = ({ item }) => {
      this.trackClick(
        item,
        item.__autocomplete_id,
        item.__autocomplete_queryID
      );
    };

    // eslint-disable-next-line consistent-this
    const self = this;
    const ac = autocomplete({
      container,
      panelContainer: container.parentNode,
      placeholder: translate(translations, locale, 'placeholder'),
      // eslint-disable-next-line spaced-comment
      //detachedMediaQuery: '', // FIXME
      debug: process.env.NODE_ENV === 'development' || debug,
      onSubmit({ state }) {
        window.location.href = `${baseUrl}${locale}/search?utf8=✓&query=${encodeURIComponent(
          state.query
        )}`;
      },
      plugins: [
        createLocalStorageRecentSearchesPlugin({
          key: 'algolia-recent-searches',
          limit: 5,
          search({ query, items, limit }) {
            // in case the query is exactly the recent item, skip it to not have a useless entry
            const results = defaultLocalStorageSearch({ query, items, limit });
            if (results.length === 1 && results[0].query === query) {
              return [];
            }
            // if the query is non-empty, really display only 2 insted of 5
            if (query !== '') {
              return results.slice(0, 2);
            }
            return results;
          },
          transformSource({ source }) {
            return {
              ...source,
              // keep this open and do another search
              onSelect({ setIsOpen }) {
                setIsOpen(true);
              },
            };
          },
        }),
      ],

      openOnFocus: true,
      onStateChange({ prevState, state, refresh }) {
        // backup state
        self.state = state;

        // hack to localize the cancel button
        if (
          state.isOpen &&
          !prevState.isOpen &&
          doc.querySelector('.aa-DetachedCancelButton') // only if displayed
        ) {
          render(
            translate(translations, locale, 'cancel'),
            doc.querySelector('.aa-DetachedCancelButton')
          );
        }

        // if answers is disabled, stop right away
        if (!bestArticle || prevState.query === state.query) {
          return;
        }

        // debounce store the best answer
        debounceGetAnswers(
          self.client.initIndex(self.indexName),
          state.query,
          lang,
          {
            facetFilters: `["locale.locale:${locale}"]`,
            clickAnalytics,
          },
          ({ hits, queryID }) => {
            answersRef.current = hits.map((hit, i) => {
              if (hit._answer.extractAttribute === 'body_safe') {
                hit._snippetResult.body_safe.value = hit._answer.extract;
              }
              // eslint-disable-next-line camelcase
              hit.__autocomplete_id = i;
              // eslint-disable-next-line camelcase
              hit.__autocomplete_queryID = queryID;
              hit.url = buildUrl(hit);
              return hit;
            });
            refresh();
          }
        );
      },
      getSources({ query: q }) {
        const sectionTitle = (hit) =>
          `${hit.category.title} - ${hit.section.title}`;
        const answersSection = {
          // ----------------
          // Source: Algolia Answers
          // ----------------
          sourceId: 'Answers',
          getItems() {
            return answersRef.current;
          },
          getItemUrl({ item }) {
            return item.url;
          },
          templates: {
            header({ items }) {
              if (items.length === 0) {
                return null;
              }
              return templates.autocomplete.articlesHeader(
                translate(translations, locale, 'bestAnswer'),
                items
              );
            },
            item({ item, components }) {
              return templates.autocomplete.answers(
                translations,
                locale,
                item,
                components
              );
            },
          },
          onSelect,
        };

        return getAlgoliaHits({
          searchClient: self.client,
          queries: [
            {
              indexName: self.indexName,
              query: q,
              params: {
                ...defaultParams,
                clickAnalytics,
                queryLanguages: [lang],
                removeStopWords: true,
                ignorePlurals: true,
              },
            },
          ],
        })
          .then((results) => {
            const hitsButBestAnswer = results[0].filter(
              (hit) => hit.objectID !== answersRef.current?.[0]?.objectID
            );
            if (!answersRef.current?.[0] && hitsButBestAnswer.length === 0) {
              return [
                {
                  sourceId: 'NoResults',
                  getItems() {
                    return [];
                  },
                  templates: {
                    noResults({ state }) {
                      return templates.autocomplete.noResults(
                        translations,
                        locale,
                        state.query
                      );
                    },
                  },
                },
              ];
            }
            const hitsByCategorySection = groupBy(
              hitsButBestAnswer,
              sectionTitle
            );
            return Object.entries(hitsByCategorySection).map(
              ([section, hits]) => {
                return {
                  sourceId: section,
                  getItems() {
                    return hits.map((hit) => {
                      hit.url = buildUrl(hit);
                      return hit;
                    });
                  },
                  getItemUrl({ item }) {
                    return item.url;
                  },
                  templates: {
                    header({ items }) {
                      return templates.autocomplete.articlesHeader(
                        section,
                        items
                      );
                    },
                    item({ item, components }) {
                      return templates.autocomplete.article(item, components);
                    },
                  },
                  onSelect,
                };
              }
            );
          })
          .then((sources) => {
            sources.unshift(answersSection);
            return sources;
          });
      },
      render({ sections }, root) {
        render(
          <Fragment>
            <div className="aa-PanelLayout">{sections}</div>
            {templates.autocomplete.footer(
              translations,
              locale,
              subdomain,
              poweredBy
            )}
          </Fragment>,
          root
        );
      },
    });

    if (keyboardShortcut) {
      const onKeyDown = (event) => {
        if (
          (event.keyCode === 27 && this.state.isOpen) ||
          // The `Cmd+K` shortcut both opens and closes the modal.
          (event.key === 'k' && (event.metaKey || event.ctrlKey))
        ) {
          event.preventDefault();
          ac.setIsOpen(!this.state.isOpen);
          ac.refresh();
        }
      };

      render(
        <div class="aa-DetachedSearchButtonSuffix">
          <span class="aa-Key">⌘</span>
          <span class="aa-Key">K</span>
        </div>,
        doc.querySelector('.aa-InputWrapperSuffix')
      );

      window.addEventListener('keydown', onKeyDown);
    }
  }
}
export default (...args) => new Autocomplete(...args);
