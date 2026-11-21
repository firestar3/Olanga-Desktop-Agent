# Olanga website

The Pages site is in `sites/olanga-web/dist/`. Edit the HTML, CSS, JavaScript and assets there. The homepage, Docs, film and privacy notice use relative URLs so they also work under `/Olanga-Desktop-Agent/`. Download buttons point to the Windows installer in GitHub Releases.

## Preview

From the repository root, run `node sites/olanga-web/preview.mjs --pages` and open [the local Pages preview](http://127.0.0.1:4174/Olanga-Desktop-Agent/). This checks the same project path used by GitHub. Check both download links, Docs, and film playback before publishing. Include the final film and its captions when they change. Keep recordings and QA output in the local workspace.

## Publish an approved preview

1. Commit the reviewed website files to `main`.
2. Open **Actions → Publish website → Run workflow**, select `main`, and run it.
3. Open the site URL from the completed deployment. Check the first-command guide and play the film.

The workflow runs on manual dispatch. App releases and ordinary pushes do not trigger a website deployment. To restore an earlier site, revert the relevant website changes on `main` and run the same workflow.

The repository uses **Settings → Pages → Build and deployment → Source → GitHub Actions**.
