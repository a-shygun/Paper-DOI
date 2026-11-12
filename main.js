const {
	Plugin, Modal, Setting, requestUrl, normalizePath,
	PluginSettingTab, FuzzySuggestModal, TFolder, TFile,
} = require("obsidian");

const DEFAULT_SETTINGS = {
	notesFolder: "Literature Notes",
	pdfFolder: "Assets",
	templatePath: "Templates/paper-import.md",
};

function parseDoiInput(value) {
	const input = String(value || "").trim();
	let doi = input;
	if (/^https:\/\/doi\.org\//i.test(input)) {
		try {
			const url = new URL(input);
			if (url.hostname.toLowerCase() !== "doi.org" || url.search || url.hash) return "";
			doi = decodeURIComponent(url.pathname.slice(1));
		} catch (_) {
			return "";
		}
	}
	return /^10\.\d{4,9}\/[\-._;()/:A-Z0-9]+$/i.test(doi) ? doi : "";
}

function yaml(value) {
	return JSON.stringify(value == null ? "" : String(value));
}

function yamlScalar(value) {
	const text = String(value || "").trim();
	if (!text) return '""';
	if (/\r?\n/.test(text)) return `|\n${text.split(/\r?\n/).map((line) => `  ${line}`).join("\n")}`;
	if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
	if (/[:\{\}\[\],&*#?]|\s#|^\s|\s$|^(true|false|yes|no|null|~)$/i.test(text) || /^\d/.test(text)) return yaml(text);
	return text;
}

function plainText(html) {
	if (!html) return "";
	const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
	return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function dateFromParts(parts) {
	if (!Array.isArray(parts) || !parts[0]?.[0]) return "";
	const [year, month = 1, day = 1] = parts[0];
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`;
}

function slug(value) {
	return (value || "Untitled Paper")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
	.trim()
	.slice(0, 150) || "Untitled Paper";
}

function abstractFromIndex(index) {
	if (!index) return "";
	const words = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const position of positions) words[position] = word;
	}
	return words.filter(Boolean).join(" ");
}

function yamlList(values) {
	return values.length ? values.map((value) => "  - " + yamlScalar(value)).join("\n") : "  []";
}

function makeTags(values) {
	return [...new Set(values.filter(Boolean).map((value) =>
		String(value).toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, ""),
	))].filter(Boolean);
}

class PaperImportModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass("paper-doi-importer-modal");
		this.contentEl.addClass("paper-doi-importer-content");
		this.titleEl.setText("Import paper by DOI");
		const intro = this.contentEl.createDiv({ cls: "paper-import-instructions" });
		intro.createEl("p", { text: "Enter a DOI to create a paper note. An open PDF is saved when available." });
		intro.createEl("p", { text: `Notes: ${this.plugin.settings.notesFolder} · PDFs: ${this.plugin.settings.pdfFolder}` });
		this.formEl = this.contentEl.createDiv({ cls: "paper-import-form" });
		new Setting(this.formEl)
			.setName("DOI or doi.org link")
			.addText((text) => {
				this.input = text;
				text.setPlaceholder("Enter a DOI or doi.org link");
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						this.submit();
					}
				});
			});
		new Setting(this.formEl).addButton((button) =>
			button.setButtonText("Import").setCta().onClick(() => this.submit()),
		);
		this.progressEl = this.contentEl.createDiv({ cls: "paper-import-progress is-hidden" });
		this.progressEl.createEl("h3", { text: "Import progress" });
		this.steps = {};
		const stepList = this.progressEl.createEl("ol", { cls: "paper-import-steps" });
		for (const [id, label] of [
			["validate", "Validate input"],
			["metadata", "Fetch paper metadata"],
			["pdf", "Check and download PDF"],
			["note", "Create Markdown note"],
		]) {
			const item = stepList.createEl("li", { cls: "paper-import-step" });
			item.dataset.step = id;
			item.createSpan({ cls: "paper-step-icon", text: "○" });
			item.createSpan({ cls: "paper-step-label", text: label });
			item.createDiv({ cls: "paper-step-detail" });
			this.steps[id] = item;
		}
		this.resultEl = this.progressEl.createDiv({ cls: "paper-import-result is-hidden" });
		this.closeButton = this.progressEl.createEl("button", { cls: "mod-cta", text: "Close" });
		this.closeButton.addEventListener("click", () => this.close());
		this.closeButton.classList.add("is-hidden");
		this.input?.inputEl.focus();
	}

	async submit() {
		const value = this.input?.getValue().trim();
		if (!value) return;
		this.formEl.addClass("is-hidden");
		this.progressEl.removeClass("is-hidden");
		this.setStep("validate", "active", "Checking DOI…");
		try {
			const result = await this.plugin.importPaper(value, (step, status, detail) => this.setStep(step, status, detail));
			this.resultEl.empty();
			this.resultEl.removeClass("is-hidden");
			this.resultEl.addClass(result.pdfPath ? "is-success" : "is-warning");
			this.resultEl.createEl("strong", { text: result.pdfPath ? "Import complete" : "Note created; no PDF downloaded" });
		} catch (error) {
			for (const [id, item] of Object.entries(this.steps)) {
				if (item.classList.contains("is-active")) this.setStep(id, "error", error.message || String(error));
			}
			this.resultEl.empty();
			this.resultEl.removeClass("is-hidden");
			this.resultEl.addClass("is-error");
			this.resultEl.createEl("strong", { text: "Import failed" });
			this.resultEl.createEl("div", { text: error.message || String(error) });
		}
		this.closeButton.classList.remove("is-hidden");
	}

	setStep(id, status, detail) {
		const item = this.steps[id];
		if (!item) return;
		item.classList.remove("is-active", "is-done", "is-warning", "is-error");
		item.classList.add(`is-${status}`);
		const icon = item.querySelector(".paper-step-icon");
		icon.setText(status === "done" ? "✓" : status === "warning" ? "!" : status === "error" ? "×" : status === "active" ? "◉" : "○");
		item.querySelector(".paper-step-detail").setText(detail || "");
	}

	onClose() {
		this.contentEl.empty();
	}
}

class FolderSuggestModal extends FuzzySuggestModal {
	constructor(app, onChoose) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a folder in this vault");
	}
	getItems() {
		return this.app.vault.getAllLoadedFiles().filter((file) => file instanceof TFolder && file.path);
	}
	getItemText(folder) { return folder.path; }
	onChooseItem(folder) { this.onChoose(folder.path); }
}

class TemplateSuggestModal extends FuzzySuggestModal {
	constructor(app, onChoose) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a Markdown template");
	}
	getItems() {
		return this.app.vault.getAllLoadedFiles().filter((file) => file instanceof TFile && file.extension === "md");
	}
	getItemText(file) { return file.path; }
	onChooseItem(file) { this.onChoose(file.path); }
}

class PaperDoiImporterSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Paper DOI Importer" });
		containerEl.createEl("p", { text: "Choose where imported notes and PDFs are saved, and which Markdown template supplies the note properties." });
		new Setting(containerEl)
			.setName("Literature note folder")
			.setDesc("Vault-relative folder for generated .md notes.")
			.addText((text) => text.setValue(this.plugin.settings.notesFolder).onChange(async (value) => {
				this.plugin.settings.notesFolder = value.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.notesFolder;
				await this.plugin.saveSettings();
			}))
			.addButton((button) => button.setButtonText("Browse…").onClick(() => new FolderSuggestModal(this.app, async (path) => {
				this.plugin.settings.notesFolder = path;
				await this.plugin.saveSettings();
				this.display();
			}).open()));
		new Setting(containerEl)
			.setName("PDF folder")
			.setDesc("Vault-relative folder for downloaded .pdf files.")
			.addText((text) => text.setValue(this.plugin.settings.pdfFolder).onChange(async (value) => {
				this.plugin.settings.pdfFolder = value.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.pdfFolder;
				await this.plugin.saveSettings();
			}))
			.addButton((button) => button.setButtonText("Browse…").onClick(() => new FolderSuggestModal(this.app, async (path) => {
				this.plugin.settings.pdfFolder = path;
				await this.plugin.saveSettings();
				this.display();
			}).open()));
		new Setting(containerEl)
			.setName("Markdown template")
			.setDesc("Select the .md file that defines the generated note’s frontmatter and body.")
			.addText((text) => text.setValue(this.plugin.settings.templatePath).onChange(async (value) => {
				this.plugin.settings.templatePath = value.trim() || DEFAULT_SETTINGS.templatePath;
				await this.plugin.saveSettings();
			}))
			.addButton((button) => button.setButtonText("Browse…").onClick(() => new TemplateSuggestModal(this.app, async (path) => {
				this.plugin.settings.templatePath = path;
				await this.plugin.saveSettings();
				this.display();
			}).open()));
	}
}

module.exports = class PaperDoiImporter extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new PaperDoiImporterSettingTab(this.app, this));
		this.addCommand({
			id: "import-paper-from-doi-or-url",
			name: "Import paper from DOI",
			callback: () => new PaperImportModal(this.app, this).open(),
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async request(url, headers = {}) {
		const response = await requestUrl({ url, method: "GET", headers, throw: false });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Request failed (${response.status}) for ${url}`);
		}
		return response;
	}

	async crossrefMetadata(doi) {
		const url = "https://api.crossref.org/works/" + doi;
		const response = await this.request(url, { Accept: "application/json" });
		const work = JSON.parse(response.text).message;
		const authors = (work.author || []).map((author) => author.name || [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean);
		const date = work["published-online"] || work["published-print"] || work.issued;
		return {
			paperId: doi.split("/").pop(), doi, title: work.title?.[0] || "", authors,
			publicationDate: dateFromParts(date?.["date-parts"]),
			abstract: plainText(work.abstract || ""),
			comments: work.comment || "",
			tags: makeTags(work.subject || []),
			pdfCandidates: (work.link || []).filter((link) => /application\/pdf/i.test(link["content-type"] || "")).map((link) => link.URL).filter(Boolean),
		};
	}

	async europePmcMetadata(doi) {
		try {
			const query = encodeURIComponent("DOI:" + doi);
			const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=" + query + "&format=json&resultType=core&pageSize=1";
			const response = await this.request(url, { Accept: "application/json" });
			const record = JSON.parse(response.text).resultList?.result?.[0];
			if (!record || record.doi?.toLowerCase() !== doi.toLowerCase()) return {};
			const rawKeywords = record.keywordList?.keyword || [];
			const keywords = Array.isArray(rawKeywords) ? rawKeywords : [rawKeywords];
			return {
				abstract: record.abstractText || "",
				tags: makeTags(keywords.map((keyword) => typeof keyword === "string" ? keyword : keyword.keyword || keyword.value || "")),
			};
		} catch (_) { return {}; }
	}

	async natureMetadata(doi) {
		if (!/^10\.1038\//i.test(doi)) return {};
		try {
			const articleId = doi.split("/").slice(1).join("/");
			const url = "https://www.nature.com/articles/" + encodeURIComponent(articleId);
			const response = await this.request(url, { Accept: "text/html,application/xhtml+xml" });
			const doc = new DOMParser().parseFromString(response.text, "text/html");
			const meta = (name) => doc.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]')?.content?.trim() || "";
			const abstractSection = doc.querySelector("#Abs1-content, [data-title='Abstract'], .c-article-section__content");
			return {
				abstract: meta("citation_abstract") || meta("dc.description") || meta("description") || meta("og:description")
					|| plainText(abstractSection?.innerHTML || ""),
			};
		} catch (_) { return {}; }
	}

	async openAlexMetadata(doi) {
		try {
			const url = "https://api.openalex.org/works/https://doi.org/" + doi;
			const response = await this.request(url, { Accept: "application/json" });
			const work = JSON.parse(response.text);
			return {
				title: work.title || work.display_name || "",
				authors: (work.authorships || []).map((entry) => entry.author?.display_name).filter(Boolean),
				publicationDate: work.publication_date ? work.publication_date + "T12:00:00" : "",
				abstract: abstractFromIndex(work.abstract_inverted_index),
				tags: makeTags((work.keywords || []).map((keyword) => keyword.display_name || keyword.keyword || "")),
				pdfCandidates: (work.locations || []).map((location) => location.pdf_url).filter(Boolean),
			};
		} catch (_) { return {}; }
	}

	async arxivMetadata(doi) {
		const id = doi.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)$/i)?.[1];
		if (!id) return {};
		try {
			const url = "https://export.arxiv.org/api/query?id_list=" + encodeURIComponent(id);
			const response = await this.request(url);
			const entry = new DOMParser().parseFromString(response.text, "text/xml").querySelector("entry");
			if (!entry) return {};
			const nodes = Array.from(entry.getElementsByTagName("*"));
			const comments = nodes.find((node) => node.localName?.toLowerCase() === "comment")?.textContent?.trim() || "";
			const categories = [...new Set(nodes
				.filter((node) => ["category", "primary_category"].includes(node.localName?.toLowerCase()))
				.map((node) => node.getAttribute("term"))
				.filter(Boolean))];
			const authors = Array.from(entry.querySelectorAll("author name"))
				.map((node) => node.textContent?.trim()).filter(Boolean);
			const published = nodes.find((node) => node.localName?.toLowerCase() === "published")?.textContent?.trim() || "";
			const abstract = entry.querySelector("summary")?.textContent?.replace(/\s+/g, " ").trim() || "";
			return {
				paperId: id,
				title: entry.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() || "",
				authors,
				comments,
				tags: makeTags(categories),
				abstract,
				publicationDate: published ? published.slice(0, 10) + "T12:00:00" : "",
				pdfCandidates: ["https://arxiv.org/pdf/" + id + ".pdf"],
			};
		} catch (_) { return {}; }
	}

	async resolvePaper(doi) {
		const arxiv = await this.arxivMetadata(doi);
		if (arxiv.title) {
			return { ...arxiv, doi, url: "https://doi.org/" + doi };
		}

		let metadata;
		try {
			metadata = await this.crossrefMetadata(doi);
		} catch (_) {
			metadata = { paperId: doi.split("/").pop(), doi, title: "", authors: [], publicationDate: "", abstract: "", pdfCandidates: [] };
		}
		const openAlex = await this.openAlexMetadata(doi);
		const europePmc = await this.europePmcMetadata(doi);
		const nature = await this.natureMetadata(doi);
		return {
			...metadata,
			title: metadata.title || openAlex.title,
			authors: metadata.authors.length ? metadata.authors : (openAlex.authors || []),
			publicationDate: metadata.publicationDate || openAlex.publicationDate || "",
			abstract: metadata.abstract || europePmc.abstract || nature.abstract || openAlex.abstract || "",
			comments: metadata.comments || "",
			tags: europePmc.tags?.length ? europePmc.tags
				: openAlex.tags?.length ? openAlex.tags
				: metadata.tags || [],
			pdfCandidates: [...metadata.pdfCandidates, ...(openAlex.pdfCandidates || [])],
			url: "https://doi.org/" + doi,
		};
	}

	async downloadPdf(candidates, title, paperId, onAttempt) {
		await this.ensureFolder(this.settings.pdfFolder);
		const base = `${slug(title)} (${slug(paperId).slice(0, 50)})`;
		for (const url of [...new Set(candidates.filter(Boolean))]) {
			try {
				onAttempt?.(`Trying ${new URL(url).host}…`);
				const response = await this.request(url, { Accept: "application/pdf,*/*;q=0.8" });
				const bytes = new Uint8Array(response.arrayBuffer);
				const signature = new TextDecoder().decode(bytes.slice(0, 5));
				if (signature !== "%PDF-") continue;
				const path = normalizePath(`${this.settings.pdfFolder}/${base}.pdf`);
				if (!this.app.vault.getAbstractFileByPath(path)) {
					await this.app.vault.adapter.writeBinary(path, response.arrayBuffer);
				}
				return path;
			} catch (_) {
				// Try the next public PDF source; metadata import should still succeed.
			}
		}
		return "";
	}

	async ensureFolder(path) {
		const normalized = normalizePath(path || "");
		if (!normalized) throw new Error("Choose a destination folder in plugin settings.");
		let current = "";
		for (const part of normalized.split("/")) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}

	async uniqueNotePath(title, paperId) {
		await this.ensureFolder(this.settings.notesFolder);
		const base = `${slug(title)} (${slug(paperId).slice(0, 50)})`;
		let path = normalizePath(`${this.settings.notesFolder}/${base}.md`);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(`${this.settings.notesFolder}/${base} (${suffix++}).md`);
		}
		return path;
	}

	async createNote(metadata, pdfPath) {
		const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatePath));
		if (!templateFile) throw new Error(`Template not found: ${this.settings.templatePath}`);
		let content = await this.app.vault.read(templateFile);
		const authorList = yamlList(metadata.authors);
		const values = {
			PAPER_ID: yamlScalar(metadata.paperId || metadata.doi || ""),
			TITLE: yamlScalar(metadata.title || "Untitled Paper"),
			AUTHORS: authorList,
			PUBLICATION_DATE: yamlScalar(metadata.publicationDate || ""),
			ABSTRACT: yamlScalar(metadata.abstract || ""),
			COMMENTS_PROPERTY: metadata.comments ? "comments: " + yamlScalar(metadata.comments) : "",
			TAGS: yamlList(metadata.tags || []),
			PDF_LINK: yaml(pdfPath ? `[[${pdfPath}]]` : ""),
			URL: yamlScalar(metadata.url || ""),
			DOI: yamlScalar(metadata.doi || ""),
		};
		for (const [key, value] of Object.entries(values)) content = content.replaceAll(`%%${key}%%`, value);
		const path = await this.uniqueNotePath(metadata.title, metadata.paperId || metadata.doi || "paper");
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(false).openFile(file);
		return path;
	}

	async importPaper(input, report = () => {}) {
		report("validate", "active", "Checking DOI format...");
		const doi = parseDoiInput(input);
		if (!doi) throw new Error("Enter only a DOI (10.xxxx/...) or a https://doi.org/10.xxxx/... link.");
		report("validate", "done", "DOI looks valid.");
		report("metadata", "active", "Looking up title, authors, publication date, and abstract...");
		const metadata = await this.resolvePaper(doi);
		if (!metadata.title) throw new Error("No metadata was found for this DOI.");
		report("metadata", "done", "Found \"" + metadata.title + "\"" + (metadata.authors.length ? " - " + metadata.authors.length + " author(s)" : "") + ".");
		report("pdf", "active", "Checking for an open-access PDF...");
		const candidates = [...new Set(metadata.pdfCandidates.filter(Boolean))];
		let pdfPath = "";
		let pdfMessage;
		if (candidates.length) {
			report("pdf", "active", "Trying " + candidates.length + " PDF source(s)...");
			pdfPath = await this.downloadPdf(candidates, metadata.title, metadata.paperId, (message) => report("pdf", "active", message));
		}
		if (pdfPath) {
			pdfMessage = "PDF saved to " + pdfPath;
			report("pdf", "done", pdfMessage);
		} else {
			pdfMessage = candidates.length ? "A PDF source was listed, but the download was blocked or returned a non-PDF response." : "No open-access PDF was listed for this DOI.";
			report("pdf", "warning", pdfMessage);
		}
		report("note", "active", "Writing the note with template " + this.settings.templatePath + "...");
		const notePath = await this.createNote(metadata, pdfPath);
		report("note", "done", "Created " + notePath);
		return { notePath, pdfPath, pdfMessage };
	}
};
