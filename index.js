#!/usr/bin/env node
/*
 *
 * nodejs script to sync a local copy of a youtube playlist.
 *
 * all mp3's that no longer appear in the playlist will be deleted.
 * all songs that do no have a local mp3 will be downloaded.
 *
 */
const script = require('commander');
const process = require('process');
const fs = require('fs');
const chalk = require('chalk');
const youtube = require('youtube-api');
const url = require('url');
const stringSimilarity = require('string-similarity');
const exec = require('child_process').exec;
const mkdirp = require('mkdirp').sync;

// script
(function() {
  // args
  var mp3Dir, playlistId = '';
  var files = [];
  var songs = [];
  var deleteQueue = [];
  var downloadQueue = [];

  // authenticate youtube api
  youtube.authenticate({type: 'key', key:'AIzaSyDkXcuOas9q8N3LAuhBSa5XHGTmEJhSoCY'});

  /**
   * parseARgs
   *
   * get dir & url
   */
  function parseArgs() {
    script.arguments('<dir> <url>')
      .action(function (dir, playlistUrl) {
        // set vars
        mp3Dir = dir;
        playlistId = url.parse(playlistUrl, true).query.list;
      })
      .parse(process.argv);
  }

  /**
   * readDir
   *
   * read contents of mp3Dir
   *
   */
  function readDir() {
    fs.readdir(mp3Dir, (err, result) => {
      if (err) {
        console.log(err);
        console.log(chalk.red('Cannot read mp3 file names.'));
      } else {
        result.forEach((file) => { files.push(file); });
      }
    });

  }

  /**
   * getMp3FileNames
   *
   * get all mp3 filenames
   *
   */
  function getMp3FileNames() {
    return files.filter((file) => { return file.endsWith('.mp3'); });
  }

  /**
   * getMp3YoutubeIdsFromFileName
   *
   * all mp3s should have youtube video ids appened to the end of the filename
   *
   *                              { id, not including special chars }
   * 'Elton John Vs Pnau - Phoenix-nL_wHlldFns.mp3'
   * '
   *
   */
  function getMp3YoutubeIdsFromFileName() {
    return getMp3FileNames().map((song) => { return song.slice(song.length-15, song.length-4); });
  }

  /**
   * validateArgs
   *
   * mp3Dir is exists, can r&w,
   *
   */
  function validateArgs() {
    // check mp3 dir exists
    if (!fs.existsSync(mp3Dir)) {
      mkdirp(mp3Dir, (err) => {
        if (err) {
          console.log(`could not create mp3 directory: ${mp3Dir}`);
        }
      });
    }

    // check mp3 dir access
    fs.accessSync(mp3Dir, fs.constants.R_OK | fs.constants.W_OK, (err) => {
      if (err) {
        console.log(chalk.red(err));
        console.log(chalk.red('Check directory path.'));
        process.exit(1);
      }
    });

    // check playlist id is valid
    youtube.playlists.list({
        part: 'snippet',
        contentDetails: 0,
        id: playlistId,
        player: 0,
        snippet: 2,
        status: 2
      },
      (error, result) => {
        if (error) {
          console.log(chalk.red(error));
          console.log(chalk.red('Check playlist url'));
          process.exit(1);
        } else if (result.items.length === 0) {
          console.log(chalk.red('Check playlist url'));
          process.exit(1);
        }

        // check directory name matches playlistname
        // get playlist name
        const playlistName = result.items[0].snippet.title;
        const dirs = mp3Dir.split('/');
        // ignore trailing '/' for directory
        const pos = mp3Dir[mp3Dir.length-1] === '/' ? dirs.length - 2 : dirs.length - 1;
        // get directory name
        const dirName = dirs[pos];
        // score comarison of dirName and playlistName
        const score = stringSimilarity.compareTwoStrings(playlistName, dirName);
        if (score < 0.5) {
          console.log(chalk.red('Looks like you have selected an incorrect directory'));
          console.log(chalk.red('Playlist name does not match directory name'));
          process.exit(1);
        }
    });
  }

  /**
   * getArgs
   *
   * get directory and playlist url that user pased in.
   * validate.
   *
   */
  function getArgs() {
    // attempt to parse and validate args if they are empty
    if (mp3Dir === '' || playlistId === '') {
      parseArgs();
      readDir();
      validateArgs();
    }
  }

  /**
   * getPlaylistItems
   *
   * get each item in a playlist
   *
   */
  function getPlaylistItems(pgToken) {
    youtube.playlistItems.list({
        part: 'snippet',
        pageToken: pgToken,
        maxResults: 50,
        playlistId: playlistId
    },
    (err, result) => {
      // check for error in request
      if (err) {
        console.log(err);
        console.log(chalk.red('Cannot get playlist items, check playlist url.'));
      } else {
        // save items
        result.items.forEach((item) => {
          songs.push(item.snippet);
        });
        // traverse to next page if necessary
        if (result.nextPageToken) {
          getPlaylistItems(result.nextPageToken);
        } else {
          getSongsToDelete();
          getSongsToDownload();
        }
      }
    });
  }

  /**
   * getSongsToDownload
   *
   * find all song ids which exist in the playlist, but
   * do not exist in the mp3 dir
   */
  function getSongsToDownload() {
    // traverse songs in playlist
    songs.forEach((song) => {
      // check if id of song exists in mp3 directory
      const mp3DirMatches = getMp3FileNames().filter((file) => { return file.includes(song.resourceId.videoId); });
      // no match?
      if (mp3DirMatches.length === 0) {
        // add to download queue
        downloadQueue.push(song);
      }
    });

    processDownloadQueue();
  }

  /**
   * getSongsToDelete()
   *
   * get all songs which exist as an mp3 but do not exist in the playlist.
   *
   */
  function getSongsToDelete() {
    const playlistIds = songs.map((song) => { return song.resourceId.videoId; });
    getMp3YoutubeIdsFromFileName()
      .forEach((mp3Id) => {
        if (!playlistIds.includes(mp3Id)) {
          deleteQueue.push(mp3Id);
        }
      });

    processDeleteQueue();
  }

  /**
   * processDeleteQueue
   *
   * process deleteQueue
   */
  function processDeleteQueue() {
    deleteQueue.forEach((id) => {
      const matches = files.filter((file) => { return file.includes(id); });
      if (matches.length === 1) {
        // delete file
        const path = mp3Dir.endsWith('/') ? mp3Dir + matches[0] : mp3Dir + '/' + matches[0];
        fs.unlink(path, (err) => {
          if (err) {
            console.log(err);
            console.log(chalk.red('Cannnot delete file.'));
          }
        });
      }
    });
  }

  /**
   * processDownloadQueue
   *
   * process download queue
   */
  function processDownloadQueue() {
    downloadQueue.forEach((song) => {
      // download song
      const path = mp3Dir.endsWith('/') ? mp3Dir : mp3Dir + '/';
      const url = `http://www.youtube.com/watch?v=${song.resourceId.videoId}`;
      const dl = `youtube-dl -o '${path}%(title)s-%(id)s.%(ext)s' -x --audio-format mp3 --audio-quality 0 ${url}`;
      exec(dl, (err, stdout, stderr) => {
        if (err) {
          console.log("************");
          console.log(song);
          console.log(url);
          console.log(dl);
          console.log("************");
          console.log(err);
          console.log(chalk.red('Cannot download audio.'));
        }
      });
    });
  }

  // script process
  getArgs();
  getPlaylistItems(null);

})();
