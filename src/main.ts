import {
  FileSystemAdapter,
  MarkdownSourceView,
  MarkdownView,
  normalizePath,
  Plugin,
  TFile,
  Notice,
  type FileView,
  type WorkspaceLeaf,
  addIcon,
} from 'obsidian';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as CodeMirror from 'codemirror';

import {
  compile as compileTemplate,
  TemplateDelegate as Template,
} from 'handlebars';


import CitationEvents from './events';
import {
  InsertCitationModal,
  InsertNoteLinkModal,
  InsertNoteContentModal,
  InsertZoteroLinkModal,
  OpenNoteModal,
} from './modals';
import { VaultExt } from './obsidian-extensions.d';
import { CitationSettingTab, CitationsPluginSettings } from './settings';
import {
  Entry,
  EntryData,
  EntryBibLaTeXAdapter,
  EntryCSLAdapter,
  IIndexable,
  Library,
} from './types';
import {
  DISALLOWED_FILENAME_CHARACTERS_RE,
  Notifier,
  WorkerManager,
  WorkerManagerBlocked,
} from './util';
import LoadWorker from 'web-worker:./worker';

export default class CitationPlugin extends Plugin {
  settings: CitationsPluginSettings;
  library: Library;

  // Template compilation options
  private templateSettings = {
    noEscape: true,
  };

  private loadWorker = new WorkerManager(new LoadWorker(), {
    blockingChannel: true,
  });

  events = new CitationEvents();

  loadErrorNotifier = new Notifier(
    'Unable to load citations. Please update Citations plugin settings.',
  );
  literatureNoteErrorNotifier = new Notifier(
    'Unable to access literature note. Please check that the literature note folder exists, or update the Citations plugin settings.',
  );

  get editor(): CodeMirror.Editor {
    const view = this.app.workspace.activeLeaf.view;
    if (!(view instanceof MarkdownView)) return null;

    const sourceView = view.sourceMode;
    return (sourceView as MarkdownSourceView).cmEditor;
  }

  async loadSettings(): Promise<void> {
    this.settings = new CitationsPluginSettings();

    const loadedSettings = await this.loadData();
    if (!loadedSettings) return;

    const toLoad = [
      'citationExportPath',
      'citationExportFormat',
      'literatureNoteTitleTemplate',
      'literatureNoteFolder',
      'literatureNoteContentTemplate',
      'markdownCitationTemplate',
      'alternativeMarkdownCitationTemplate',
    ];
    toLoad.forEach((setting) => {
      if (setting in loadedSettings) {
        (this.settings as IIndexable)[setting] = loadedSettings[setting];
      }
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

	//add command to right-click menu
	addMenuItem(name, icon) {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu) => {
				menu.addItem((item) => {
					item.setTitle(name)
          .setIcon(icon)
					.onClick(() => {
						//@ts-ignore
            // https://www.reddit.com/r/ObsidianMD/comments/188fygp/how_to_get_the_current_line_which_im_writing_in/
            const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
            if (!editor) return;

            const cursor = editor.getCursor();
            const lineText = editor.getLine(cursor.line);
            if (!lineText) return;
            // Use regex to find the word at the cursor position
            const wordMatch = lineText.match(/\b\w+\b/g);
            if (!wordMatch) return;
            // Find the word under the cursor
            let wordAtCursor = "";
            let startIndex = 0;
            for (const word of wordMatch) {
                const wordStart = lineText.indexOf(word, startIndex);
                const wordEnd = wordStart + word.length;
                if (cursor.ch >= wordStart && cursor.ch <= wordEnd) {
                    wordAtCursor = word;
                    break;
                }
                startIndex = wordEnd; // Ensure we don't match the same word multiple times
            }
            console.log("Word at cursor:", wordAtCursor);

            // Check if the extracted word is a citekey
            if (this.library && (wordAtCursor in this.library.entries)) {
                console.log(`Citekey found: ${wordAtCursor}`);
                const zoteroUrl = this.library.entries[wordAtCursor].zoteroPdfURI;
                console.log(`Opening Zotero: ${zoteroUrl}`);
                window.open(zoteroUrl);
            } else {
                console.log(`No matching citekey found for: ${wordAtCursor}`);
                new Notice(`No matching citation found for ${wordAtCursor}`);
            }
					});
				});
			})
		);
	}

  onload(): void {
    this.loadSettings().then(() => this.init());

    // Chris Open-Paper-In-Zotero additions, TODO make function
    addIcon('letter-z', `<polyline points="29 19 86 19 29 96 86 96" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
    this.addMenuItem("Open Paper in Zotero", "letter-z");

    this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.addButtonIfMatching(leaf);
			})
		);

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle('Open Paper in Zotero')
            .setIcon('letter-z')
            .onClick(async () => {
              if (file && this.library && (file.name.slice(0,-3) in this.library.entries)) {
                const zoteroUrl = this.library.entries[file.name.slice(0,-3)].zoteroPdfURI;
                new Notice(`Opening ${zoteroUrl}`);
                window.open(zoteroUrl);
              }
            });
        });
      })
    );
  }

	onunload() {
		console.log(`[${this.manifest.name}] Unloaded`);
		this.removeButton();
	}

  addButtonIfMatching(leaf?: WorkspaceLeaf | null) {
		if (!leaf) return;
		const file = leaf.view.file;
    if (!file || !this.library || !(leaf.view.file.basename in this.library.entries)) {
			this.removeButton();
			return;
		}
    console.log(`Filename is a Citekey: ${leaf.view.file.basename}`);
    const zoteroUrl = this.library.entries[leaf.view.file.basename].zoteroPdfURI;
    console.log(zoteroUrl);

		const view = leaf.view as FileView;
		if (!view || view.getState().mode !== "source") return; // TODO do I want this
		// Ensure button is not duplicated
		if (document.querySelector(".custom-header-button")) return;
    const button = view.addAction("letter-z", "Open in Zotero", () => {
			new Notice(`Opening ${zoteroUrl}`);
      window.open(zoteroUrl);
		});
		button.addClass("custom-header-button");
	}

	removeButton() {
		const button = document.querySelector(".custom-header-button");
		if (button) button.remove();
	}


  async init(): Promise<void> {
    if (this.settings.citationExportPath) {
      // Load library for the first time
      this.loadLibrary();

      // Set up a watcher to refresh whenever the export is updated
      try {
        // Wait until files are finished being written before going ahead with
        // the refresh -- here, we request that `change` events be accumulated
        // until nothing shows up for 500 ms
        // TODO magic number
        const watchOptions = {
          awaitWriteFinish: {
            stabilityThreshold: 500,
          },
        };

        chokidar
          .watch(
            this.resolveLibraryPath(this.settings.citationExportPath),
            watchOptions,
          )
          .on('change', () => {
            this.loadLibrary();
          });
      } catch {
        this.loadErrorNotifier.show();
      }
    } else {
      // TODO show warning?
    }

    this.addCommand({
      id: 'open-literature-note',
      name: 'Open literature note',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'o' }],
      callback: () => {
        const modal = new OpenNoteModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'update-bib-data',
      name: 'Refresh citation database',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'r' }],
      callback: () => {
        this.loadLibrary();
      },
    });

    this.addCommand({
      id: 'insert-citation',
      name: 'Insert literature note link',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'e' }],
      callback: () => {
        const modal = new InsertNoteLinkModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-literature-note-content',
      name: 'Insert literature note content in the current pane',
      callback: () => {
        const modal = new InsertNoteContentModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-zotero-link',
      name: 'Insert Zotero link to pdf or entry',
      callback: () => {
        const modal = new InsertZoteroLinkModal(this.app, this);
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-markdown-citation',
      name: 'Insert Markdown citation',
      callback: () => {
        const modal = new InsertCitationModal(this.app, this);
        modal.open();
      },
    });

    this.addSettingTab(new CitationSettingTab(this.app, this));
  }

  /**
   * Resolve a provided library path, allowing for relative paths rooted at
   * the vault directory.
   */
  resolveLibraryPath(rawPath: string): string {
    const vaultRoot =
      this.app.vault.adapter instanceof FileSystemAdapter
        ? this.app.vault.adapter.getBasePath()
        : '/';
    return path.resolve(vaultRoot, rawPath);
  }

  async loadLibrary(): Promise<Library> {
    console.debug('Citation plugin: Reloading library');
    if (this.settings.citationExportPath) {
      const filePath = this.resolveLibraryPath(
        this.settings.citationExportPath,
      );

      // Unload current library.
      this.events.trigger('library-load-start');
      this.library = null;

      return FileSystemAdapter.readLocalFile(filePath)
        .then((buffer) => {
          // If there is a remaining error message, hide it
          this.loadErrorNotifier.hide();

          // Decode file as UTF-8.
          const dataView = new DataView(buffer);
          const decoder = new TextDecoder('utf8');
          const value = decoder.decode(dataView);

          return this.loadWorker.post({
            databaseRaw: value,
            databaseType: this.settings.citationExportFormat,
          });
        })
        .then((entries: EntryData[]) => {
          let adapter: new (data: EntryData) => Entry;
          let idKey: string;

          switch (this.settings.citationExportFormat) {
            case 'biblatex':
              adapter = EntryBibLaTeXAdapter;
              idKey = 'key';
              break;
            case 'csl-json':
              adapter = EntryCSLAdapter;
              idKey = 'id';
              break;
          }

          this.library = new Library(
            Object.fromEntries(
              entries.map((e) => [(e as IIndexable)[idKey], new adapter(e)]),
            ),
          );
          console.debug(
            `Citation plugin: successfully loaded library with ${this.library.size} entries.`,
          );

          this.events.trigger('library-load-complete');

          return this.library;
        })
        .catch((e) => {
          if (e instanceof WorkerManagerBlocked) {
            // Silently catch WorkerManager error, which will be thrown if the
            // library is already being loaded
            return;
          }

          console.error(e);
          this.loadErrorNotifier.show();

          return null;
        });
    } else {
      console.warn(
        'Citations plugin: citation export path is not set. Please update plugin settings.',
      );
    }
  }

  /**
   * Returns true iff the library is currently being loaded on the worker thread.
   */
  get isLibraryLoading(): boolean {
    return this.loadWorker.blocked;
  }

  get literatureNoteTitleTemplate(): Template {
    return compileTemplate(
      this.settings.literatureNoteTitleTemplate,
      this.templateSettings,
    );
  }

  get literatureNoteContentTemplate(): Template {
    return compileTemplate(
      this.settings.literatureNoteContentTemplate,
      this.templateSettings,
    );
  }

  get markdownCitationTemplate(): Template {
    return compileTemplate(
      this.settings.markdownCitationTemplate,
      this.templateSettings,
    );
  }

  get alternativeMarkdownCitationTemplate(): Template {
    return compileTemplate(
      this.settings.alternativeMarkdownCitationTemplate,
      this.templateSettings,
    );
  }

  getTitleForCitekey(citekey: string): string {
    const unsafeTitle = this.literatureNoteTitleTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
    return unsafeTitle.replace(DISALLOWED_FILENAME_CHARACTERS_RE, '_');
  }

  getPathForCitekey(citekey: string): string {
    const title = this.getTitleForCitekey(citekey);
    // TODO escape note title
    return path.join(this.settings.literatureNoteFolder, `${title}.md`);
  }

  getInitialContentForCitekey(citekey: string): string {
    return this.literatureNoteContentTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  getMarkdownCitationForCitekey(citekey: string): string {
    return this.markdownCitationTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  getAlternativeMarkdownCitationForCitekey(citekey: string): string {
    return this.alternativeMarkdownCitationTemplate(
      this.library.getTemplateVariablesForCitekey(citekey),
    );
  }

  getEntryZoteroLinkForCitekey(citekey: string): string {
    return `[${citekey}](zotero://select/items/${citekey})`;
  }

  getPdfZoteroLinkForCitekey(citekey: string): string {
    const variables = this.library.getTemplateVariablesForCitekey(citekey);
    return `[${citekey}:pdf](${variables.zoteroPdfURI})`;
  }


  /**
   * Run a case-insensitive search for the literature note file corresponding to
   * the given citekey. If no corresponding file is found, create one.
   */
  async getOrCreateLiteratureNoteFile(citekey: string): Promise<TFile> {
    const path = this.getPathForCitekey(citekey);
    const normalizedPath = normalizePath(path);

    let file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file == null) {
      // First try a case-insensitive lookup.
      const matches = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.toLowerCase() == normalizedPath.toLowerCase());
      if (matches.length > 0) {
        file = matches[0];
      } else {
        try {
          file = await this.app.vault.create(
            path,
            this.getInitialContentForCitekey(citekey),
          );
        } catch (exc) {
          this.literatureNoteErrorNotifier.show();
          throw exc;
        }
      }
    }

    return file as TFile;
  }

  async openLiteratureNote(citekey: string, newPane: boolean): Promise<void> {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        this.app.workspace.getLeaf(newPane).openFile(file);
      })
      .catch(console.error);
  }

  async insertLiteratureNoteLink(citekey: string): Promise<void> {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        const useMarkdown: boolean = (<VaultExt>this.app.vault).getConfig(
          'useMarkdownLinks',
        );
        const title = this.getTitleForCitekey(citekey);

        let linkText: string;
        if (useMarkdown) {
          const uri = encodeURI(
            this.app.metadataCache.fileToLinktext(file, '', false),
          );
          linkText = `[${title}](${uri})`;
        } else {
          linkText = `[[${title}]]`;
        }

        this.editor.replaceSelection(linkText);
      })
      .catch(console.error);
  }

  /**
   * Format literature note content for a given reference and insert in the
   * currently active pane.
   */
  async insertLiteratureNoteContent(citekey: string): Promise<void> {
    const content = this.getInitialContentForCitekey(citekey);
    this.editor.replaceRange(content, this.editor.getCursor());
  }

  async insertMarkdownCitation(
    citekey: string,
    alternative = false,
  ): Promise<void> {
    const func = alternative
      ? this.getAlternativeMarkdownCitationForCitekey
      : this.getMarkdownCitationForCitekey;
    const citation = func.bind(this)(citekey);

    this.editor.replaceRange(citation, this.editor.getCursor());
  }

  async insertZoteroLink(
    citekey: string,
    alternative = false,
  ): Promise<void> {
    const func = alternative
      ? this.getEntryZoteroLinkForCitekey
      : this.getPdfZoteroLinkForCitekey;
    const link = func.bind(this)(citekey);

    this.editor.replaceRange(link, this.editor.getCursor());
  }
}
