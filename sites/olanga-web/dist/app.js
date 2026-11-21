(() => {
  'use strict';
  const videos = [...document.querySelectorAll('.film video')];
  const tour = document.querySelector('dialog#productfilm');
  const chapterMenu = tour?.querySelector('details.transcript');
  const players = new Map();
  for (const video of videos) {
    const frame = video.closest('.film');
    const button = frame.querySelector('.film-play');
    const error = frame.querySelector('.film-error');
    const modal = video.closest('dialog');
    const label = button.querySelector('span').textContent;
    let activeRequest = null;
    let retrySeconds;
    let sourceFailed = false;
    const sources = [...video.querySelectorAll('source')];
    const failedSources = new Set();
    const resetButton = () => {
      button.disabled = false;
      button.querySelector('span').textContent = !error.hidden ? 'Try again' : video.ended ? label + ' again' : label;
      frame.setAttribute('aria-busy', 'false');
    };
    const failPlayback = failure => {
      if (activeRequest) {
        activeRequest.failure = failure;
        activeRequest.stop(failure);
      }
      video.pause();
      error.hidden = false;
      button.hidden = false;
      resetButton();
    };
    button.hidden = false;
    const cancelRequest = () => {
      if (activeRequest) {
        activeRequest.stop(Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' }));
        activeRequest.cleanup();
        activeRequest = null;
      }
    };
    const stop = () => {
      cancelRequest();
      video.pause();
      button.hidden = false;
      resetButton();
    };
    const start = async (trigger, seconds) => {
      if (modal && !modal.open) return;
      // An older request cannot change the latest selection, focus or loading state.
      cancelRequest();
      const request = { focusWanted: document.activeElement === trigger, cleanup: () => {} };
      const stopped = new Promise((resolve, reject) => { request.stop = reject; });
      activeRequest = request;
      if (seconds === undefined && !error.hidden) seconds = retrySeconds;
      retrySeconds = seconds;
      const isTrigger = target => target === trigger || trigger.contains(target);
      const pointerAway = event => { if (!isTrigger(event.target)) request.focusWanted = false; };
      const focusAway = event => {
        if (!isTrigger(event.target) && event.target !== document.body && event.target !== video) request.focusWanted = false;
      };
      const tabAway = event => { if (event.key === 'Tab') request.focusWanted = false; };
      let onMetadata;
      request.cleanup = () => {
        document.removeEventListener('pointerdown', pointerAway, true);
        document.removeEventListener('focusin', focusAway, true);
        document.removeEventListener('keydown', tabAway, true);
        if (onMetadata) video.removeEventListener('loadedmetadata', onMetadata);
      };
      document.addEventListener('pointerdown', pointerAway, true);
      document.addEventListener('focusin', focusAway, true);
      document.addEventListener('keydown', tabAway, true);
      error.hidden = true;
      button.disabled = true;
      button.querySelector('span').textContent = 'Loading film…';
      frame.setAttribute('aria-busy', 'true');
      try {
        if (seconds !== undefined) {
          if (chapterMenu?.open && chapterMenu.contains(trigger)) {
            chapterMenu.open = false;
            video.focus({ preventScroll: true });
          } else if (!modal) {
            frame.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
        }
        // A failed resource remains failed until load() starts a fresh request.
        if (video.error || sourceFailed) {
          sourceFailed = false;
          failedSources.clear();
          video.load();
        }
        if (seconds !== undefined) {
          const seek = () => {
            if (activeRequest !== request) return;
            video.currentTime = Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds;
          };
          if (video.readyState >= 1) seek();
          else {
            // play() begins the on-demand load. Apply the chapter as soon as
            // metadata is available, before the first decoded frame plays.
            onMetadata = () => {
              try { seek(); }
              catch (failure) { request.seekFailure = failure; video.pause(); }
            };
            video.addEventListener('loadedmetadata', onMetadata, { once: true });
          }
        }
        await Promise.race([video.play(), stopped]);
        if (activeRequest !== request) return;
        if (request.seekFailure) throw request.seekFailure;
        // A slow load must not pull focus back after the visitor moves on.
        const focusStayed = isTrigger(document.activeElement) || document.activeElement === document.body || document.activeElement === video;
        if (request.focusWanted && focusStayed && !video.paused && !video.closest('[hidden]') && !document.hidden) {
          video.focus({ preventScroll: true });
        }
      } catch (failure) {
        if (activeRequest !== request) return;
        button.hidden = false;
        if (request.seekFailure || request.failure || failure.name !== 'AbortError') error.hidden = false;
      } finally {
        request.cleanup();
        if (activeRequest === request) {
          resetButton();
          activeRequest = null;
        }
      }
    };
    button.addEventListener('click', () => start(button));
    players.set(video.id, { start, stop });
    video.addEventListener('play', () => {
      if (modal && !modal.open) { stop(); return; }
      for (const other of videos) if (other !== video) other.pause();
      error.hidden = true;
    });
    video.addEventListener('playing', () => {
      if (modal && !modal.open) { stop(); return; }
      button.hidden = true;
    });
    video.addEventListener('ended', () => {
      button.hidden = false;
      button.querySelector('span').textContent = label + ' again';
    });
    video.addEventListener('error', () => failPlayback(new Error('The film could not be loaded.')));
    // A failed <source> can leave play() pending without a video.error.
    // Account for all candidates so a valid fallback source can still load.
    for (const source of sources) source.addEventListener('error', () => {
      failedSources.add(source);
      if (failedSources.size !== sources.length) return;
      sourceFailed = true;
      failPlayback(new Error('No film source could be loaded.'));
    });
  }
  document.querySelectorAll('[data-tour-seek]').forEach(trigger => {
    const player = players.get(trigger.getAttribute('aria-controls'));
    const seconds = Number(trigger.dataset.tourSeek);
    if (!player || !Number.isFinite(seconds) || seconds < 0) return;
    trigger.addEventListener('click', () => player.start(trigger, seconds));
  });
  const pauseAll = () => videos.forEach(video => video.pause());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAll(); });
  window.addEventListener('pagehide', pauseAll);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) continue;
        // An instant chapter jump can leave a queued offscreen observation.
        // Recheck the current geometry before pausing the now-visible film.
        const rect = entry.target.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) entry.target.pause();
      }
    });
    videos.forEach(video => observer.observe(video));
  }

  const studioHeader = document.querySelector('.studio-page .studio-header');
  if (studioHeader) {
    const updateHeader = () => studioHeader.classList.toggle('over-photo', window.scrollY < 48);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  const docsContents = document.querySelector('.docs-contents');
  if (docsContents) {
    const narrow = matchMedia('(max-width: 800px)');
    const fitContents = () => { docsContents.open = !narrow.matches; };
    fitContents();
    narrow.addEventListener('change', fitContents);
    docsContents.addEventListener('click', event => {
      if (narrow.matches && event.target.closest('a[href^="#"]')) docsContents.open = false;
    });
  }
  const mobileNavigation = document.querySelector('.mobile-navigation');
  if (mobileNavigation) {
    const summary = mobileNavigation.querySelector('summary');
    mobileNavigation.addEventListener('click', event => {
      if (event.target.closest('a[href^="#"]')) mobileNavigation.open = false;
    });
    mobileNavigation.addEventListener('keydown', event => {
      if (event.key === 'Escape' && mobileNavigation.open) {
        event.preventDefault();
        mobileNavigation.open = false;
        summary.focus({ preventScroll: true });
      }
    });
    document.addEventListener('pointerdown', event => {
      if (mobileNavigation.open && !mobileNavigation.contains(event.target)) mobileNavigation.open = false;
    });
    matchMedia('(max-width: 800px)').addEventListener('change', event => {
      if (!event.matches) mobileNavigation.open = false;
    });
  }

  function closeOnBackdrop(dialog) {
    let backdropPress = false;
    const outsideDialog = event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', event => { backdropPress = outsideDialog(event); });
    dialog.addEventListener('pointerup', event => {
      if (backdropPress && outsideDialog(event)) dialog.close();
      backdropPress = false;
    });
  }
  const dialog = document.querySelector('#screenshot-dialog');
  if (typeof dialog?.showModal === 'function') {
    let captureOpener;
    const image = document.createElement('img');
    const caption = dialog.querySelector('.capture-footer p');
    const defaultCaption = caption.textContent;
    dialog.querySelector('.capture-view').append(image);
    document.querySelectorAll('a[data-capture]').forEach(link => {
      link.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        if (dialog.open) return;
        captureOpener = link;
        const thumbnail = link.querySelector('img');
        image.src = link.href;
        image.alt = thumbnail.alt;
        caption.textContent = link.dataset.caption || defaultCaption;
        dialog.querySelector('#capture-title').textContent = link.dataset.capture;
        dialog.querySelector('.original-capture').href = link.href;
        pauseAll();
        dialog.showModal();
        document.documentElement.classList.add('dialog-open');
      });
    });
    dialog.addEventListener('close', () => {
      if (document.querySelector('dialog[open]')) return;
      document.documentElement.classList.remove('dialog-open');
      captureOpener?.focus({ preventScroll: true });
    });
    closeOnBackdrop(dialog);
  }

  const tourPlayer = players.get('film-product');
  if (typeof tour?.showModal === 'function' && tourPlayer) {
    let opener = null;
    const openTour = trigger => {
      if (tour.open) return;
      opener = trigger;
      if (trigger && mobileNavigation?.contains(trigger)) {
        opener = mobileNavigation.querySelector('summary');
        mobileNavigation.open = false;
      }
      tour.showModal();
      document.documentElement.classList.add('dialog-open');
      if (trigger) return tourPlayer.start(trigger);
    };
    document.querySelectorAll('[data-open-tour]').forEach(link => {
      link.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        return openTour(link);
      });
    });
    if (chapterMenu) {
      tour.addEventListener('cancel', event => {
        if (!chapterMenu.open) return;
        event.preventDefault();
        chapterMenu.open = false;
        chapterMenu.querySelector('summary').focus({ preventScroll: true });
      });
      tour.addEventListener('pointerdown', event => {
        if (chapterMenu.open && !chapterMenu.contains(event.target)) chapterMenu.open = false;
      });
    }
    closeOnBackdrop(tour);
    tour.addEventListener('close', () => {
      if (tour.open) return;
      tourPlayer.stop();
      if (chapterMenu) {
        chapterMenu.open = false;
        for (const details of chapterMenu.querySelectorAll('details[open]')) details.open = false;
      }
      if (!document.querySelector('dialog[open]')) {
        document.documentElement.classList.remove('dialog-open');
        opener?.focus({ preventScroll: true });
      }
      opener = null;
      if (window.location.hash === '#productfilm') {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      }
    });
    const followTourLink = () => {
      if (window.location.hash === '#productfilm') openTour(null);
      else if (tour.open) tour.close();
    };
    window.addEventListener('hashchange', followTourLink);
    followTourLink();
  }
  document.querySelectorAll('img[data-fallback]').forEach(img => {
    const fallback = () => {
      if (img.dataset.fallback) {
        const source = img.dataset.fallback;
        delete img.dataset.fallback;
        img.src = source;
        img.alt = 'Olanga Windows interface with example content';
      }
    };
    img.addEventListener('error', fallback, { once: true });
    if (img.complete && img.naturalWidth === 0) fallback();
  });
  const nextSteps = document.querySelector('#download-next-steps');
  document.querySelectorAll('.download-installer').forEach(link => {
    link.addEventListener('click', () => {
      const status = link.closest('.hero-copy,.download-inner')?.querySelector('[role="status"]');
      if (status && nextSteps && !status.hasChildNodes()) {
        status.append(nextSteps.content.cloneNode(true));
      }
    });
  });
})();
