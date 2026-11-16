# Brain

A personal, TheBrain-style knowledge graph with an inbox for everything you capture and a list of actions.
It runs locally: a small Node server on `http://localhost:4321` with a SQLite file. It has no dependencies and sends nothing to the internet.

## Start

Double-click `start-brain.cmd`, or run:

```
npm start
```

It needs Node.js 22.13 or newer, because it uses the built-in `node:sqlite`. Run `npm install` once to get `pdfjs-dist`, the library that reads text from PDFs. It is already installed in this folder.

## Concepts

| Concept | What it is |
|---|---|
| **Thought** | A topic, project, person or org. It is a node in your graph. |
| **Link** | *Parent/child* gives hierarchy, and a thought can have several parents. *Jump* means "related" across branches. Siblings are derived from shared parents. |
| **Plex** | The main view. The active thought sits in the centre, with parents above, children below, jumps on the left and siblings on the right. Click any thought to move to it. |
| **Item** | Anything captured: a Teams chat, a mail, a transcript, a OneNote or Notepad++ note, a paper note you typed in. It has a source, a date and the people involved. |
| **Inbox** | Items not yet triaged. **Move to…** attaches an item to a thought and removes it from the Inbox. |
| **Action** | A to-do with a due date, an owner and a status (open, waiting, done). It links to thoughts and to the item it came from. |

Each thought page shows **Notes** (what I need to know), **Actions** (what I need to do) and a **Timeline** of every item attached to it.

## Getting content in

* **Capture** (`c` or the ＋ Capture button). Paste anything, pick the source, add topics and optionally an action in the same step. When you're on a thought, it is pre-attached.
* **Drop files** onto the page. On a thought page, the file is attached to that thought. Elsewhere, it goes to the Inbox.
* **Folder watch.** Save or copy files into `inbox\`. They are imported within a few seconds and moved to `inbox\_imported\`. Files that fail go to `inbox\_failed\`.

Supported files:

| Type | What is imported |
|---|---|
| `.txt .md .log` | The text. Notepad++ files work, in UTF-8 or UTF-16. |
| `.msg` `.eml` | Outlook and other mail: subject, sender, recipients, date, body, and the names of any attachments (not their contents). |
| `.vtt` `.docx` | Teams meeting transcripts and Word documents. |
| `.pdf` | The PDF's text. Scanned PDFs without text are read with Windows OCR, up to 30 pages. |
| `.png .jpg .jpeg` | Text recognised with the OCR built into Windows. The image is shown on the card. |

The original file is kept in `data\files\`, and each card has a 📎 link to open it.

**About the OCR.** It runs offline and uses the OCR languages installed in Windows. Only English (en-US) is installed on this machine right now. For Dutch, go to *Settings → Time & language → Language & region*, add Dutch, and make sure *Optical character recognition* is included. Handwriting is recognised poorly. Printed text and screenshots work well.

Tips per source:

* **Outlook.** Drag a mail from classic Outlook into the `inbox\` folder in File Explorer, which creates a `.msg` file there. In new Outlook, use *Save as* to get `.eml`.
* **Screenshots** of chats or slides: save them as `.png` into `inbox\`.
* **Teams meeting.** Download the transcript (`.vtt` or `.docx`) from the meeting recap and drop it in.
* **Teams chat, WhatsApp, OneNote.** Select the text, copy it, then press `c` and paste.
* **Paper.** Type the key points into Capture, with source *paper*.

## Links to documents and web pages

Each thought has a **Links** box next to its Timeline. Paste a link and press Enter, or drag a link or tab from your browser onto the box. If you leave the title empty, it is guessed from the link. Rename it later with ✎.

* **OneDrive or SharePoint:** in Office or OneDrive, use *Share → Copy link*, or copy the address from the browser. It opens in a new tab.
* **Synced OneDrive file on this PC:** in File Explorer, right-click the file and choose *Copy as path*, then paste. Clicking the link opens the file in its own app (Word, Excel, …), and 📂 shows it in its folder. The link stops working if the file is moved or renamed.
* **Any web page:** paste the address.

Links appear in search, by title and by address.

## Workflow suggestion

1. Capture everything quickly to the Inbox. Don't organize while capturing.
2. Once a day, empty the Inbox. Select a sentence and click **→ Action** for every to-do, then click **Move to…** to attach the item to a topic or person, which also removes it from the Inbox. To attach an item to several topics, use **＋ topic** first, then **✓ Done**.
3. Before a meeting, open the topic or person to see notes, open actions and the timeline.
4. Check **Actions**, grouped by Overdue, Today, Next 7 days and so on. Use *Waiting for* for things others owe you.

## Shortcuts

`c` capture · `/` search · `i` inbox · `a` actions · `h` home · `Ctrl+Enter` save a dialog · `Esc` close.
In any topic picker, type `@Name` to create a person.

## Data

* Database: `data\brain.db` (SQLite), plus the original imported files in `data\files\`.
* **Backup:** run `.\backup-brain.ps1`. It creates `backups\brain-backup-<date>_<time>.zip` with a consistent, integrity-checked copy of the database and the original files. It is safe to run while the app is running. Options:
  * `-Destination D:\Backups\Brain` to write somewhere else;
  * `-Keep 14` to keep only the newest 14 backups;
  * `-DatabaseOnly` to skip the original files.

  If PowerShell blocks the script, use `powershell -ExecutionPolicy Bypass -File .\backup-brain.ps1`.
* **Restore:** stop the app, unzip a backup, copy `brain.db` to `data\brain.db` and `files\` to `data\files\`, then start the app.
* Settings, as environment variables: `BRAIN_PORT` (4321), `BRAIN_DB`, `BRAIN_WATCH`.
* The server listens on 127.0.0.1 only and rejects cross-site requests.
* This folder is inside OneDrive, so the database is synced. Run the app on one machine at a time.
