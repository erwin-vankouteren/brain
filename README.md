# Brain

A personal, TheBrain-style knowledge graph with an inbox for everything you capture and a list of actions.
It runs as a small Node server on `http://localhost:4321`. You can keep several **brains**: *local* brains (a SQLite file on this computer) and *cloud* brains (an Azure SQL database you can open from more than one laptop).

## Start

Double-click `start-brain.cmd`, or run:

```
npm start
```

It needs Node.js 22.13 or newer, because it uses the built-in `node:sqlite`. Run `npm install` once to get the libraries: `pdfjs-dist` reads text from PDFs, and `mssql` with `@azure/identity` is used only by cloud brains.

## Brains: local and cloud

The brain switcher in the header shows which brain you're in, and the bar at the top of the window is coloured to match:

* **💻 Local brain (green).** A SQLite file on this computer, with the original files in a folder next to it. A local brain **never** uses the network or Azure: it can only be opened with SQLite. Use this for work information, to stay within company policy. Your original brain is the local **Work brain** (`data\brain.db`, inbox folder `inbox\`).
* **☁️ Cloud brain (blue).** An Azure SQL database. Add the same database on every laptop (for example your personal laptop and your work laptop), and they all see the same content. Original files (PDFs, images, mails) are stored in the database too.

Every brain has its own Inbox and its own watched inbox folder on this computer. By default the folder is `inbox-<name>\` in the app folder, and you can change it in *Manage brains*. Items never move between brains.

**New brain:** click the brain switcher, then *＋ New brain…*. **Rename, change the inbox folder, or remove from this computer's list:** *⚙ Manage brains…*. Removing a brain from the list never deletes its data.

The list of brains on a computer is kept in `brains.json`. It isn't in git, because every laptop has its own list.

### Setting up a cloud brain (Azure SQL free offer)

1. In the Azure portal, create an **Azure SQL Database** and choose **Apply offer** for the free offer (serverless, €0 within the monthly free limits). Create a new server along with it.
2. **Sign-in to the server.** Choose one:
   * **Microsoft Entra (recommended, no password stored).** Make yourself the Entra admin of the server. On each laptop, install the Azure CLI and run `az login --tenant <your-tenant>` once. In the app, choose *Microsoft account* and fill in the tenant, so a work account is never used by mistake.
   * **SQL authentication.** Create a SQL login. The app encrypts the password with Windows DPAPI, so it can only be decrypted by your Windows user on that laptop.
3. **Networking.** Allow public access and add a firewall rule for each laptop's public IP address. Some company networks block outgoing port 1433. In that case the work laptop can't reach the database while it's on the company network.
4. In the app, choose *＋ New brain…* → *Azure SQL*, then enter the server (`<name>.database.windows.net`) and the database name. The app creates its tables on first connect.
5. Repeat step 4 on the other laptop, with the same server and database.

After an idle period the free database pauses. The first action after that can take up to a minute while it wakes up.

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
* **Folder watch.** Save or copy files into the brain's inbox folder (`inbox\` for the Work brain). They are imported into that brain within a few seconds and moved to `_imported\` inside that folder. Files that fail go to `_failed\`.

Supported files:

| Type | What is imported |
|---|---|
| `.txt .md .log` | The text. Notepad++ files work, in UTF-8 or UTF-16. |
| `.msg` `.eml` | Outlook and other mail: subject, sender, recipients, date, body, and the names of any attachments (not their contents). |
| `.vtt` `.docx` | Teams meeting transcripts and Word documents. |
| `.pdf` | The PDF's text. Scanned PDFs without text are read with Windows OCR, up to 30 pages. |
| `.png .jpg .jpeg` | Text recognised with the OCR built into Windows. The image is shown on the card. |

The original file is kept, and each card has a 📎 link to open it. Local brains store it in the `files\` folder next to their database; cloud brains store it in the database.

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

Links appear in search, by title and by address. Thoughts are found by name and by their notes.

## Workflow suggestion

1. Capture everything quickly to the Inbox. Don't organize while capturing.
2. Once a day, empty the Inbox. Select a sentence and click **→ Action** for every to-do, then click **Move to…** to attach the item to a topic or person, which also removes it from the Inbox. To attach an item to several topics, use **＋ topic** first, then **✓ Done**.
3. Before a meeting, open the topic or person to see notes, open actions and the timeline.
4. Check **Actions**, grouped by Overdue, Today, Next 7 days and so on. Use *Waiting for* for things others owe you.

## Search

Type in the search box at the top (or press `/`). While you type, the list shows matching thoughts and the first items whose text contains your words. Press Enter, or choose *Search everything*, for the full results: thoughts, items, actions and links.

* **Items are searched in their full text:** everything you captured or pasted, mail bodies, meeting transcripts, the text read from PDFs and images, the people, and the name of the attached file.
* **Every word must occur** somewhere in the result, in any order: `jan budget` finds the chat where Jan talks about the budget. Put words in quotes to find them as one phrase: `"steering committee"`.
* Upper and lower case don't matter, including accented letters (`café` finds `Café`).
* The words are highlighted in the results. For long items, such as a transcript, the lines around the matches are shown above the text.
* Each section shows up to 100 results. If there are more, add a word to narrow the search.

## Shortcuts

`c` capture · `/` search · `i` inbox · `a` actions · `h` home · `Ctrl+Enter` save a dialog · `Esc` close.
In any topic picker, type `@Name` to create a person.

## Data

* **Work brain:** `data\brain.db` (SQLite), plus the original imported files in `data\files\`. Other local brains are in `data\brains\<id>\`. Cloud brains are in Azure SQL.
* **Backup:** run `.\backup-brain.ps1`. For every *local* brain it creates `backups\brain-backup-<brain>-<date>_<time>.zip`, holding a consistent, integrity-checked copy of the database and the original files. It is safe to run while the app is running. Cloud brains are skipped, because Azure SQL makes its own automatic backups. Options:
  * `-Brain work` to back up one brain only;
  * `-Destination D:\Backups\Brain` to write somewhere else;
  * `-Keep 14` to keep only the newest 14 backups per brain;
  * `-DatabaseOnly` to skip the original files.

  If PowerShell blocks the script, use `powershell -ExecutionPolicy Bypass -File .\backup-brain.ps1`.
* **Restore:** stop the app, unzip a backup, copy `brain.db` and `files\` back into the brain's data folder (for the Work brain that is `data\`), then start the app.
* Settings, as environment variables: `BRAIN_PORT` (4321) and `BRAIN_HOME` (the folder holding `brains.json`, `data\` and the inbox folders; the default is the app folder). `BRAIN_DB` and `BRAIN_WATCH` only apply the first time, when `brains.json` is created.
* The server listens on 127.0.0.1 only and rejects cross-site requests.
* This folder is inside OneDrive, so local databases are synced. Run a local brain on one machine at a time. Cloud brains can be used from several laptops at once.
