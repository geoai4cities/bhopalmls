// Overview video: one picture in four sizes (1080p to 360p) with two narrations, English (default) and
// Hindi, packaged as HLS by docs/paper/bhopal-mls/video/scripts/encode_web.sh. Ported from the
// accessibility page (web/src/video/OverviewVideo.ts). hls.js (hls.min.js beside this file, 1.7.3,
// Apache-2.0, hls.LICENSE) plays it wherever Media Source Extensions exist: it starts on the rendition
// that fits its first bandwidth guess and the player size, then switches at 6 s segment boundaries as
// the measured bandwidth allows. Elsewhere (iOS Safari) the browser plays the playlist natively and
// the narration is switched through video.audioTracks.
// Bytes before play: the master playlist on page load. When the player scrolls into view, the rendition
// playlists plus the first 6 s segment of picture and narration (the title card, about 0.3 MB), so the
// first frame shows on the click; nothing more until play. Skipped when the browser asks to save data.
// The silent preview loop in the hero (#hero-loop, optional) plays while on screen; a click on it brings
// the player into view and starts it.
(function () {
  'use strict';
  var SRC = 'assets/video/hls/master.m3u8';
  var video = document.getElementById('overview-video');
  var bar = document.getElementById('video-lang');
  var chapters = document.getElementById('video-chapters');
  var hero = document.getElementById('hero-loop');
  var playBtn = document.getElementById('video-play');
  if (!video || !bar) return;
  var buttons = Array.prototype.slice.call(bar.querySelectorAll('button[data-lang]'));
  var chips = chapters ? Array.prototype.slice.call(chapters.querySelectorAll('button[data-t]')) : [];
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var select = function () { return false; };   // narration switch, set per backend
  var startAt = function () {};                 // begin loading at a position when idle, set per backend
  var prefetch = function () {};                // first segments when in view, set per backend

  function ready() {
    bar.hidden = false;
    if (chapters) chapters.hidden = false;
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        if (!select(b.dataset.lang)) return;
        buttons.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        // Choosing a narration is a request to hear it: unmute, and play if paused.
        video.muted = false;
        if (video.paused) video.play().catch(function () {});
      });
    });
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

  // Big play button over the poster: shown while paused (and before the first play), hidden while playing.
  if (playBtn) {
    var syncPlayBtn = function () { playBtn.hidden = !video.paused; };
    playBtn.addEventListener('click', function () { video.play().catch(function () {}); });
    ['play', 'pause', 'ended'].forEach(function (ev) { video.addEventListener(ev, syncPlayBtn); });
    syncPlayBtn();
  }

  // Hero preview: a silent loop beside the study-area figure. It plays while on screen (not under reduced
  // motion or save-data, where its poster stays); a click brings the overview video into view and starts it.
  var loop = hero ? hero.querySelector('video') : null;
  if (hero) {
    hero.addEventListener('click', function (e) {
      e.preventDefault();
      var section = document.getElementById('video');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      video.play().catch(function () {});
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

  if (window.Hls && window.Hls.isSupported()) {
    var Hls = window.Hls;
    var hls = new Hls({
      autoStartLoad: false,          // nothing until in view (first segments) or play
      capLevelToPlayerSize: true,    // never fetch more pixels than the player shows
      abrEwmaDefaultEstimate: 1.2e6, // first pick is 480p (986 kb/s with audio); measured bandwidth takes over after a segment
      maxBufferLength: 60,
      maxMaxBufferLength: 120
    });
    var loading = false;
    var start = function (pos) { if (!loading) { loading = true; hls.startLoad(pos); } };
    var stop = function () { if (loading) { loading = false; hls.stopLoad(); } };
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
    hls.on(Hls.Events.ERROR, function (_e, data) {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { loading = false; start(-1); }
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { hls.destroy(); bar.hidden = true; if (chapters) chapters.hidden = true; }
    });
    hls.loadSource(SRC);
    hls.attachMedia(video);
    video.__hls = hls;   // for the headless checks in the build notes
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = SRC;
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

  // When the player scrolls into view: prefetch the first segments.
  function inView() { prefetch(); }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); inView(); }
    }, { threshold: 0.2 });
    io.observe(video);
  } else {
    inView();
  }
})();
