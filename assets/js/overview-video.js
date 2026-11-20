// The page's HLS players, both played by hls.js (hls.min.js beside this file, 1.7.3, Apache-2.0,
// hls.LICENSE) wherever Media Source Extensions exist; elsewhere (iOS Safari) the browser plays the
// playlist natively. hls.js starts on the rendition that fits its first bandwidth guess and the player
// size, then switches at segment boundaries as the measured bandwidth allows.
//   Overview (#overview-video in #video): one picture in four sizes (1080p to 360p) with two narrations,
//     English (default) and Hindi, packaged by docs/paper/bhopal-mls/video/scripts/encode_web.sh. Ported
//     from the accessibility page (web/src/video/OverviewVideo.ts). Natively, the narration is switched
//     through video.audioTracks. Bytes before play: the master playlist on page load; when the player
//     scrolls into view, the rendition playlists plus the first 6 s of picture and narration (the title
//     card, about 0.3 MB), so the first frame shows on the click. Nothing when the browser asks to save data.
//   Hero clip (#highlight-video in #hero-clip, optional): the wide social clip cut to 38 s, silent,
//     captions burnt in, four sizes in 2 s segments, packaged by
//     docs/paper/bhopal-mls/social-media/scripts/encode_page.sh. Autoplay only (user 11-20): no controls,
//     muted, looping while on screen, held (paused, not loading) off screen and while the overview plays.
//     Under reduced motion or save-data its poster stays. Its controls (user 11-20): play/pause
//     (#hero-clip-pp) and full screen (#hero-clip-fs; Esc exits too), plus a spinner (#hero-clip-spin) while
//     it waits for data. The size cap is set here, not by hls.js (o.manualCap): hls.js's own capping throws
//     away the buffered video ahead whenever the cap rises, so entering full screen on the live page
//     (GitHub Pages, a few Mb/s from campus) emptied the buffer and the clip stuck (11-20).
//     Source: the page's own copy (data-hls, a versioned folder). Served over https (the live page), the same
//     path is streamed through the mirror named in data-hls-mirror (jsDelivr, which mirrors the page's public
//     GitHub repo; user 11-20): from campus GitHub Pages carried a 4 MB segment in 23-26 s (about 1.3 Mb/s,
//     the clip played 360p), jsDelivr in 2 s on a first request and 0.3 s cached. Any fatal network error on
//     the mirror (path not mirrored yet after a push, CDN down) switches to the own copy. ?cdn=1 / ?cdn=0 in
//     the page URL force the mirror on / off (checks). The URL lives in the HTML, not here: this script is
//     shared with the review-anonymous build, whose gate rejects the lab's name.
// One player at a time: playing one by hand holds the other.
// A click on the hero card (#hero-clip, or #hero-loop on the review-anonymous page, which keeps the 8 s
// viewer loop teaser.mp4) brings the overview into view and starts it.
(function () {
  'use strict';
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var players = [];

  // o: video, src (required); langBar, chapters, playBtn (optional); estimate = hls.js's first bandwidth
  // guess in bit/s, which picks the first rendition (measured bandwidth takes over after a segment);
  // bufferAhead = seconds to load ahead of the playhead.
  // Returns { video, hold }: hold() pauses and stops loading without counting as the viewer's pause.
  function setup(o) {
    var video = o.video, bar = o.langBar, chapters = o.chapters, playBtn = o.playBtn;
    var buttons = bar ? Array.prototype.slice.call(bar.querySelectorAll('button[data-lang]')) : [];
    var chips = chapters ? Array.prototype.slice.call(chapters.querySelectorAll('button[data-t]')) : [];
    var select = function () { return false; };   // narration switch, set per backend
    var startAt = function () {};                 // begin loading at a position when idle, set per backend
    var prefetch = function () {};                // first segments when in view, set per backend
    var stop = function () {};                    // stop loading, set per backend
    var p = { video: video, auto: false, held: false, userPaused: false, resume: function () {} };
    players.push(p);

    function ready() {
      if (bar) bar.hidden = false;
      if (chapters) chapters.hidden = false;
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          if (!select(b.dataset.lang)) return;
          buttons.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          // Choosing a narration is a request to hear it: unmute, and play if paused.
          video.muted = false;
          if (video.paused) video.play().catch(function () {});
        });
      });
    }
    function failed() {
      if (bar) bar.hidden = true;
      if (chapters) chapters.hidden = true;
    }

    // Chapters: one button per shot, data-t in seconds; the one playing is marked.
    function markChapter() {
      var t = video.currentTime, current = null;
      chips.forEach(function (c) { if (+c.dataset.t <= t + 0.25) current = c; });
      chips.forEach(function (c) { c.setAttribute('aria-current', c === current ? 'true' : 'false'); });
    }
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        var t = +c.dataset.t;
        startAt(t);
        video.currentTime = t;
        video.play().catch(function () {});
      });
    });
    video.addEventListener('timeupdate', markChapter);
    video.addEventListener('seeked', markChapter);

    // A play the viewer asked for pauses the other player; an automatic start (p.auto) does not.
    video.addEventListener('play', function () {
      p.userPaused = false;
      if (p.auto) { p.auto = false; return; }
      players.forEach(function (q) { if (q !== p && !q.video.paused) q.hold(); });
    });
    video.addEventListener('pause', function () {
      if (p.held) { p.held = false; return; }
      if (!video.ended) p.userPaused = true;
      players.forEach(function (q) { if (q !== p) q.resume(); });   // a looping clip on screen may start again
    });
    p.hold = function () {
      if (!video.paused) { p.held = true; video.pause(); }
      stop();
    };

    // Big play button over the poster: shown while paused (and before the first play), hidden while playing.
    if (playBtn) {
      var syncPlayBtn = function () { playBtn.hidden = !video.paused; };
      playBtn.addEventListener('click', function () { video.play().catch(function () {}); });
      ['play', 'pause', 'ended'].forEach(function (ev) { video.addEventListener(ev, syncPlayBtn); });
      syncPlayBtn();
    }

    if (window.Hls && window.Hls.isSupported()) {
      var Hls = window.Hls;
      var ahead = o.bufferAhead || 60;
      var hls = new Hls({
        autoStartLoad: false,          // nothing until in view (first segments) or play
        capLevelToPlayerSize: !o.manualCap,   // never fetch more pixels than the player shows
        abrEwmaDefaultEstimate: o.estimate || 1.2e6,
        maxBufferLength: ahead,
        maxMaxBufferLength: 2 * ahead
      });
      var loading = false;
      var start = function (pos) { if (!loading) { loading = true; hls.startLoad(pos); } };
      stop = function () { if (loading) { loading = false; hls.stopLoad(); } };
      startAt = function (t) { start(t); };
      prefetch = function () {
        if (loading || saveData) return;
        var got = { main: false, audio: false };
        var onBuffered = function (_e, data) {
          if (!video.paused) { hls.off(Hls.Events.FRAG_BUFFERED, onBuffered); return; }   // playing: keep going
          got[data.frag.type] = true;
          if (got.main && (got.audio || !hls.audioTracks.length)) {
            hls.off(Hls.Events.FRAG_BUFFERED, onBuffered);
            stop();
          }
        };
        hls.on(Hls.Events.FRAG_BUFFERED, onBuffered);
        start(-1);
      };
      select = function (lang) {
        var i = hls.audioTracks.findIndex(function (t) { return t.lang === lang; });
        if (i < 0) return false;
        hls.audioTrack = i;
        return true;
      };
      hls.once(Hls.Events.MANIFEST_PARSED, ready);
      video.addEventListener('play', function () { start(video.currentTime > 0.5 ? video.currentTime : -1); });
      var srcNow = o.src;
      hls.on(Hls.Events.ERROR, function (_e, data) {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && o.fallback && srcNow !== o.fallback) {
          // The mirror failed: the own copy, from the start (loadSource re-attaches the media). Play again only if
          // it was playing or about to (play() was called).
          srcNow = o.fallback;
          var replay = !video.paused;
          loading = false;
          hls.stopLoad();
          hls.loadSource(srcNow);
          if (replay) {
            hls.once(Hls.Events.MANIFEST_PARSED, function () {
              p.auto = true;
              video.play().catch(function () { p.auto = false; });
            });
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { loading = false; start(-1); }
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); failed(); }
      });
      if (o.manualCap) {
        // Same rule as hls.js (smallest frame that covers the player at up to 2x pixel density, its highest
        // bitrate; the largest when none covers it), but setting hls.autoLevelCapping only steers the next
        // segments: nothing buffered is thrown away when the cap rises.
        var recap = function () {
          var lv = hls.levels;
          if (!lv || !lv.length) return;
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          var w = video.clientWidth * dpr, h = video.clientHeight * dpr;
          var cap = lv.length - 1;
          for (var i = 0; i < lv.length; i++) {
            var next = lv[i + 1];
            var top = !next || next.width !== lv[i].width || next.height !== lv[i].height;
            if ((lv[i].width >= w || lv[i].height >= h) && top) { cap = i; break; }
          }
          if (hls.autoLevelCapping === cap) return;
          var rose = cap > hls.autoLevelCapping && hls.autoLevelCapping >= 0;
          hls.autoLevelCapping = cap;
          if (rose) upgrade(cap);
        };
        // The cap rose (full screen, a bigger window). Only when the measured bandwidth carries a better rung with
        // room to spare (1.5x its bitrate): keep the next 8 s buffered as a cushion and drop what lies beyond, so
        // hls.js refetches it at that rung. On a slower link nothing buffered is dropped.
        var upgrade = function (cap) {
          var lv = hls.levels, est = hls.bandwidthEstimate, now = lv[hls.loadLevel];
          if (!now || !(est > 0)) return;
          var best = -1;
          for (var i = 0; i <= cap; i++) if (lv[i].bitrate * 1.5 <= est) best = i;
          if (best < 0 || lv[best].bitrate <= now.bitrate) return;
          hls.trigger(Hls.Events.BUFFER_FLUSHING, { startOffset: video.currentTime + 8, endOffset: Infinity, type: null });
        };
        var recapTimer = null;
        var recapSoon = function () { clearTimeout(recapTimer); recapTimer = setTimeout(recap, 250); };
        hls.on(Hls.Events.MANIFEST_PARSED, recap);
        window.addEventListener('resize', recapSoon);
        document.addEventListener('fullscreenchange', recapSoon);
        document.addEventListener('webkitfullscreenchange', recapSoon);
      }
      hls.loadSource(o.src);
      hls.attachMedia(video);
      video.__hls = hls;   // for the headless checks in the build notes
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = o.src;
      if (o.fallback) {
        var onSrcError = function () {
          video.removeEventListener('error', onSrcError);
          var replay = !video.paused;
          video.src = o.fallback;
          if (replay) video.play().catch(function () {});
        };
        video.addEventListener('error', onSrcError);
      }
      prefetch = function () { if (!saveData) video.preload = 'metadata'; };
      select = function (lang) {
        var tracks = video.audioTracks;
        if (!tracks) return false;
        var found = false, i;
        for (i = 0; i < tracks.length; i++) found = tracks[i].language === lang || found;
        if (!found) return false;
        for (i = 0; i < tracks.length; i++) tracks[i].enabled = tracks[i].language === lang;
        return true;
      };
      video.addEventListener('loadedmetadata', ready, { once: true });
    }

    // Plays while on screen (o.autoplay), else prefetches the first segments the first time it is in view.
    var autoplay = o.autoplay && !reduceMotion && !saveData;
    var visible = false;
    p.resume = function () {
      if (!autoplay || !visible || p.userPaused || !video.paused) return;
      if (players.some(function (q) { return q !== p && !q.video.paused; })) return;   // another is playing
      p.auto = true;
      video.muted = true;
      video.play().catch(function () { p.auto = false; });
    };
    function onScreen(yes) {
      var fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (!yes && fs && fs.contains(video)) return false;   // full screen: the page behind may scroll it out of view
      if (!autoplay) { if (yes && !o.autoplay) prefetch(); return yes; }   // a held autoplay clip shows its poster only
      visible = yes;
      if (yes) p.resume(); else p.hold();
      return false;
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        var yes = entries[entries.length - 1].isIntersecting;
        if (onScreen(yes)) io.disconnect();
      }, { threshold: autoplay ? 0.35 : 0.2 });
      io.observe(video);
    } else {
      onScreen(true);
    }
    return p;
  }

  var overview = document.getElementById('overview-video');
  var langBar = document.getElementById('video-lang');
  if (overview && langBar) {
    setup({
      video: overview, src: 'assets/video/hls/master.m3u8', langBar: langBar,
      chapters: document.getElementById('video-chapters'), playBtn: document.getElementById('video-play'),
      estimate: 1.2e6   // first pick 480p (986 kb/s with audio); the first segment is the title card
    });
  }
  var clip = document.getElementById('highlight-video');
  var fsElement = function () { return document.fullscreenElement || document.webkitFullscreenElement; };
  if (clip) {
    var own = clip.getAttribute('data-hls') || 'assets/video/highlight/master.m3u8';
    var mirror = clip.getAttribute('data-hls-mirror');
    var cdn = new URLSearchParams(location.search).get('cdn');
    var viaMirror = !!mirror && (cdn === '1' || (cdn !== '0' && location.protocol === 'https:'));
    setup({
      video: clip, src: viaMirror ? mirror + own : own, fallback: viaMirror ? own : null,
      estimate: 2.5e6,   // first pick 480p (1650 kb/s): the clip opens on the flight in, not on a title card
      bufferAhead: 40,   // the whole 38 s clip while on screen, so a slow patch never stalls it and loops replay
                         // from the buffer; off screen it stops loading (hold)
      manualCap: true,
      autoplay: true
    });
  }
  // Hero clip full screen: the Fullscreen API on the frame (clip + button), webkit-prefixed on older Safari. iPhone
  // Safari has it for <video> only, so there the browser's own video full screen opens (it brings its own exit).
  var fsBtn = document.getElementById('hero-clip-fs');
  var frame = document.getElementById('hero-clip-frame');
  if (clip && fsBtn && frame) {
    var canFs = !!(frame.requestFullscreen || frame.webkitRequestFullscreen)
      && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    if (!canFs && !clip.webkitEnterFullscreen) fsBtn.hidden = true;
    var paintFs = function () {
      var on = fsElement() === frame;
      frame.classList.toggle('is-fs', on);
      fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
      fsBtn.title = on ? 'Exit full screen (Esc)' : 'Full screen';
    };
    fsBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();   // not the card's click, which opens the overview
      if (fsElement() === frame) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      if (clip.paused) clip.play().catch(function () {});   // asking for full screen is asking to watch
      if (canFs) {
        var r = (frame.requestFullscreen || frame.webkitRequestFullscreen).call(frame);
        if (r && typeof r.catch === 'function') r.catch(function () {});
      } else {
        clip.webkitEnterFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', paintFs);
    document.addEventListener('webkitfullscreenchange', paintFs);
  }

  // Hero clip play/pause, and a spinner for waits longer than 0.3 s (a quick seek or loop does not flash it).
  var ppBtn = document.getElementById('hero-clip-pp');
  if (clip && ppBtn) {
    var paintPP = function () {
      var on = !clip.paused;
      ppBtn.classList.toggle('is-playing', on);
      ppBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
      ppBtn.title = on ? 'Pause' : 'Play';
    };
    ppBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();   // not the card's click
      if (clip.paused) clip.play().catch(function () {}); else clip.pause();
    });
    clip.addEventListener('play', paintPP);
    clip.addEventListener('pause', paintPP);
    paintPP();
  }
  var spin = document.getElementById('hero-clip-spin');
  if (clip && spin) {
    var spinTimer = null;
    var spinOff = function () { clearTimeout(spinTimer); spinTimer = null; spin.hidden = true; };
    var spinOn = function () {
      if (spinTimer || !spin.hidden) return;
      spinTimer = setTimeout(function () {
        spinTimer = null;
        if (!clip.paused && clip.readyState < 3) spin.hidden = false;
      }, 300);
    };
    clip.addEventListener('waiting', spinOn);
    clip.addEventListener('play', function () { if (clip.readyState < 3) spinOn(); });
    ['playing', 'pause', 'canplay'].forEach(function (ev) { clip.addEventListener(ev, spinOff); });
    clip.addEventListener('timeupdate', function () { if (!spin.hidden && clip.readyState >= 3) spinOff(); });
  }

  // Hero card: a click brings the narrated overview into view and starts it (not while the clip is full screen).
  var hero = document.getElementById('hero-clip') || document.getElementById('hero-loop');
  // Review-anonymous page: the 8 s viewer loop plays while on screen (not under reduced motion or save-data,
  // where its poster stays).
  var loop = hero && hero.id === 'hero-loop' ? hero.querySelector('video') : null;
  if (hero && overview) {
    hero.addEventListener('click', function (e) {
      e.preventDefault();
      if (fsElement()) return;
      var section = document.getElementById('video');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      overview.play().catch(function () {});
    });
    if (loop && (reduceMotion || saveData)) loop = null;
    if (loop && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) loop.play().catch(function () {}); else loop.pause();
        });
      }, { threshold: 0.1 }).observe(loop);
    } else if (loop) {
      loop.play().catch(function () {});
    }
  }
})();
