module.exports = {
  dev: {
    browser: 'chrome',
    polyfill: true,
  },
  browser: {
    chrome: {
      preferences: {theme: "dark"},
      browserFlags: ["--starting-url", "https://music.youtube.com/watch?v=Emq17wn71jA&list=RDAMVMxe9j9hPn6Bc"],
      profile: "dist/chrome-profile"
    },
    firefox: {
      preferences: {darkMode: true},
    },
  },
  output: {
    publicPath: 'chrome-extension://effdbpeggelllpfkjppbokhmmiinhlmg/'
  }
};