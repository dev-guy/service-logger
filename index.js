/* eslint-disable no-plusplus */
/* eslint-disable no-multi-assign */
/* eslint-disable no-param-reassign */
/* eslint-disable-next-line max-classes-per-file */
const hostId = require('hostid');
const mkdirp = require('mkdirp-sync');
const humanizeDuration = require('humanize-duration');
const Joi = require('joi');
const prune = require('json-prune');
const util = require('util');
const { v1: uuidv1 } = require('uuid');
const path = require('path');
// Winston includes
const winston = require('winston');
require('winston-daily-rotate-file'); // This looks weird but it's correct
const { consoleFormat: WinstonConsoleFormat } = require('winston-console-format');
const WinstonCloudWatch = require('winston-cloudwatch');

// =============================
// Notes
// typeof(null) === 'object'

const { format } = winston;

const banner = '[@goodware/log] ';

const transportNames = ['file', 'errorFile', 'cloudWatch', 'console'];

/**
 * @private
 * @ignore
 * @description Removes internal functions from the stack trace
 */
const stripStack = /\n {4}at [^(]+\(.*[/|\\]@goodware[/|\\]log[/|\\][^)]+\)/g;

/**
 * @private
 * @ignore
 * @description Used for tag filtering
 */
const transportObj = {};
transportNames.forEach((transport) => {
  transportObj[transport] = true;
});

/**
 * @private
 * @ignore
 * @description Which datatypes are scalars
 */
const scalars = {
  number: true,
  string: true,
  boolean: true,
};

/**
 * @private
 * @ignore
 * @description Category names for internal loggers
 */
const logCategories = {
  unhandled: '@log/unhandled',
  cloudWatch: '@log/cloudwatch-error',
  log: '@log/log', // When the API is misused
};

/**
 * @private
 * @ignore
 * @description Internal class for identifying log entries that are created by Loggers::logEntry
 */
class LogEntry {}

/**
 * @description Manages logger objects that can send log entries to the console, files, and AWS CloudWatch Logs
 */
class Loggers {
  /**
   * Private Properties
   *  {Object} options
   *  {Boolean} props.starting
   *  {Boolean} props.stopping
   *  {Boolean} props.stopped
   *  {String} props.created
   *  {String} props.hostId
   *  {String} props.logsDirectory
   *  {String[]} props.metaKeys
   *  {Object} props.meta {String} key -> {String} metaKey
   *  {Function} props.unhandledPromiseListener
   *  {Function[]} props.stopWaiters
   *  {String[]} props.levels {String} with 'default'
   *  {Object} props.logStackLevels
   *  {Object} props.winstonLoggers {String} category -> Winston logger
   *  {Object} props.userMeta {String} metaFieldName -> undefined
   *  {Object} unitTest
   *  {Object} props.cloudWatch Properties:
   *   {String} streamName
   *   {Object[]} transports
   *  {Object} props.loggers {String} category -> {Loggers|Logger}
   *  {Object} props.categoryTags {String} category -> {{String} tag -> {Object}}
   *  {Object} props.logLevel {String} level name or 'default' -> {logLevel: {String}}
   *  {Object} props.levelSeverity {String} level plus 'on', 'off', and 'default'
   *   -> {Number} {Object} winstonLevels Passed to Winston when creating a logger
   *
   * Notes to Maintainers
   *  1. tags, message, and context provided to public methods should never be modified
   *  2. The output of Object.keys and Object.entries should be cached for static objects
   *
   * @todo
   * 1. When console data is requested but colors are disabled, output data without colors using a new formatter
   * 2. Add a new data prop to output to the plain console
   * 3. Document level-named methods take a tag name as a string if the first argument has no space
   * 4. Document defaultTagAllowLevel
   * 5. Document custom levels and colors
   * 6. Test redaction
   * 7. Document redaction
   * 8. Move Logger to another module - see
   *    https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de
   */
  /**
   * @constructor
   * @param {Object} options
   * @param {Object} [levels] An object with properties levels and colors, both of which are objects whose keys are
   *  level names. This is the same object that is provided when creating Winston loggers. See an example at
   *  https://www.npmjs.com/package/winston#using-custom-logging-levels
   */
  constructor(options, levels = Loggers.defaultLevels) {
    /**
     * @private
     * @ignore
     * @description Internal properties
     */
    this.props = {};
    this.props.stopped = true;

    // This must be set before validating options
    this.props.levels = Object.keys(levels.levels);

    // Copy environment variables to options (begin)

    /**
     * @private
     * @ignore
     * @description Sets options.console.{key} if a CONSOLE_{KEY} environment variable exists
     * @param {String} key 'data' or 'colors'
     */
    const envToConsoleKey = (key) => {
      const envKey = `CONSOLE_${key.toUpperCase()}`;
      const value = process.env[envKey];
      if (value === undefined) return;
      options.console[key] = value === 'true' ? true : !!Number(value);
    };

    // Copy environment variables to options (end)

    // Validate options
    options = this.validateOptions(options);

    envToConsoleKey('colors');
    envToConsoleKey('data');

    // Do not add default until after validating
    this.props.levels.push('default');

    // Level color
    {
      let { colors } = levels;
      const { levelColors } = options;
      if (levelColors) {
        colors = { ...colors };
        Object.entries(levelColors).forEach(([level, color]) => {
          colors[level] = color;
        });
      }

      winston.addColors(colors);
    }

    /**
     * @type {Object}
     * @description Maps level names to integers where lower values have higher severity
     */
    this.winstonLevels = levels.levels;

    // Level severity
    this.props.levelSeverity = { ...levels.levels };
    Object.assign(this.props.levelSeverity, {
      off: -1,
      default: this.props.levelSeverity[options.defaultLevel],
      on: 100000,
    });

    this.props.created = Loggers.now();
    this.props.hostId = hostId();

    this.props.loggers = {};
    this.props.winstonLoggers = {};

    // Process meta keys (begin)
    this.props.meta = {};
    this.props.userMeta = {};

    Object.entries(options.metaKeys).forEach(([key, value]) => {
      this.props.meta[key] = key;
      if (value) {
        key = value;
        this.props.meta[key] = key;
      }
      this.props.userMeta[key] = undefined;
    });

    this.props.meta.message = 'message';

    this.props.metaKeys = Object.keys(this.props.meta);
    // Process meta keys (end)

    // Add the default category if it's missing
    {
      const category = options.categories;
      if (!category.default) category.default = {};
    }

    // logLevel is used by level-named methods
    this.props.logLevel = {};
    this.props.levels.forEach((logLevel) => {
      this.props.logLevel[logLevel] = { logLevel };
    });

    // Process category tag switches
    this.props.categoryTags = {};
    if (!this.processCategoryTags('default')) {
      this.props.categoryTags.default = { on: true };
    }

    // Set props.logStackLevels
    {
      const obj = (this.props.logStackLevels = {});
      options.logStackLevels.forEach((level) => {
        if (level === 'default') level = options.defaultLevel;
        obj[level] = true;
      });
    }

    // Dynamic logging-level methods
    this.addLevelMethods(this);

    this.start();
  }

  /**
   * @private
   * @ignore
   * @description Converts a number to a string with leading zeroes
   * @param {Number} num The number to convert
   * @param {Number} size The minimum number of digits
   * @return {String} num converted to a string with leading zeroes if necessary
   */
  static pad(num, size = 2) {
    let s = num.toString();
    while (s.length < size) s = `0${s}`;
    return s;
  }

  /**
   * @private
   * @ignore
   * @description Returns local time in ISO8601 format with the local timezone offset
   * @return {String}
   */
  static now() {
    const now = new Date();
    const tzo = now.getTimezoneOffset();

    return `${now.getFullYear()}-${Loggers.pad(now.getMonth() + 1)}-${Loggers.pad(now.getDate())}T${Loggers.pad(
      now.getHours()
    )}:${Loggers.pad(now.getMinutes())}:${Loggers.pad(now.getSeconds())}.${Loggers.pad(now.getMilliseconds(), 3)}${
      !tzo ? 'Z' : `${(tzo > 0 ? '-' : '+') + Loggers.pad(Math.abs(tzo) / 60)}:${Loggers.pad(tzo % 60)}`
    }`;
  }

  /**
   * @description Combines two sets of tags into a single object
   * @param {*} [tags]
   * @param {*} [moreTags]
   * @return {Object} An object consisting of tags and moreTags combined, one key per tag name whose truthy value
   *  indicates the tag is enabled, or undefined if tags and moreTags are falsey
   */
  static tags(tags, moreTags) {
    let newTags;

    if (tags) {
      if (typeof tags === 'object') {
        if (tags instanceof Array) {
          newTags = {};
          tags.forEach((tag) => {
            if (tag) newTags[tag] = true;
          });
        } else if (!moreTags) {
          return tags;
        } else {
          newTags = { ...tags };
        }
      } else {
        newTags = {};
        newTags[tags] = true;
      }
    }

    if (moreTags) {
      if (typeof moreTags === 'object') {
        if (moreTags instanceof Array) {
          if (!newTags) newTags = {};
          moreTags.forEach((tag) => {
            if (tag) newTags[tag] = true;
          });
        } else if (!newTags) {
          return moreTags;
        } else {
          if (!newTags) newTags = {};
          Object.assign(newTags, moreTags);
        }
      } else {
        if (!newTags) newTags = {};
        newTags[moreTags] = true;
      }
    }

    return newTags;
  }

  /**
   * @private
   * @ignore
   * @description Converts an context value to an object
   * @param {*} [context]
   * @return {Object} If context is falsey, returns context. If context is a string, returns {logMessage: context}. If
   *  context is an Error, returns {error: context}. If context is an array, returns {logArray: context}.
   */
  static contextToObject(context) {
    if (context === undefined || context === null) return undefined;
    if (typeof context === 'object') {
      if (context instanceof Error) return { error: context };
      if (!(context instanceof Array)) return context;
    }
    return { context };
  }

  /**
   * @description Combines the keys of two context objects and returns a new object
   * @param {*} [context]
   * @param {*} [more]
   * @return {Object} false if context and more are falsey. If context is truthy and more is falsey,
   * returns context or context converted to an object. If more is truthy and context is falsey, returns
   * more or more converted to an object. Otherwise, returns a new object with context and more
   * converted to objects and combined such that more's keys overwite context's keys.
   */
  static context(context, more) {
    if (!context && !more) return false;

    context = Loggers.contextToObject(context);
    more = Loggers.contextToObject(more);

    if (context && !more) return context;
    if (more && !context) return more;

    const contexts = { ...context };
    Object.assign(contexts, more);
    return contexts;
  }

  /**
   * @private
   * @ignore
   * @description Determines whether an object has any properties. Faster than Object.keys(object).length.
   *  See https://jsperf.com/testing-for-any-keys-in-js
   * @param {Object} object An object to test
   * @return {Boolean} true if object has properties (including inherited)
   */
  static hasKeys(object) {
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const prop in object) return true;
    return false;
  }

  /**
   * @private
   * @ignore
   * @description Adds methods named after levels, such as error()
   * @param target The object to modify
   */
  addLevelMethods(target) {
    this.props.levels.forEach((level) => {
      target[level] = (...args) => Loggers.levelLog(target, this.props.logLevel[level], ...args);
    });
  }

  /**
   * @description Processes options
   * @param {Object} options
   * @return {Object} options with defaults added
   */
  validateOptions(options) {
    if (!options) options = {};

    // ==== Joi model for options (begin)
    const levelEnum = Joi.string().valid(...this.props.levels);
    const defaultLevelEnum = Joi.alternatives(levelEnum, Joi.string().valid('default'));
    const offDefaultLevelEnum = Joi.alternatives(defaultLevelEnum, Joi.string().valid('off'));
    const onOffDefaultLevelEnum = Joi.alternatives(offDefaultLevelEnum, Joi.string().valid('on'));

    // Region and logGroup are required by winston-cloudwatch but they can be
    // provided under categories
    const cloudWatchLogObject = Joi.object({
      region: Joi.string(),
      logGroup: Joi.string(),
      uploadRate: Joi.number()
        .integer()
        .min(1)
        .default(2000)
        .description('The frequency in which entries are sent to CloudWatch. Number of milliseconds between flushes.'),
    });

    const cloudWatchObject = cloudWatchLogObject
      .keys({
        flushTimeout: Joi.number().integer().min(1).default(90000).description(
          `The maximum number of milliseconds to wait when sending the current batch of log entries to \
CloudWatch`
        ),
      })
      .default({});

    const cloudWatchCategoryObject = cloudWatchLogObject.keys({
      level: onOffDefaultLevelEnum,
    });

    //  Options provided to the constructor. The defaults in this object assume the following levels exist:
    // error, warn, debug
    const optionsSchema = Joi.object({
      // Process-related meta
      stage: Joi.string(),
      service: Joi.string(),
      version: Joi.string(),

      // Defaults
      defaultCategory: Joi.string().default('general'),
      defaultLevel: levelEnum.default('debug').description('Which level to use when a level is not found in tags'),
      defaultTagAllowLevel: offDefaultLevelEnum.default('warn'),

      // Colors
      levelColors: Joi.object().pattern(levelEnum, Joi.string().required()),

      // Set the 'stack' meta with the current call stack
      logStackLevels: Joi.array().items(defaultLevelEnum).default(['error']),

      // Meta keys
      metaKeys: Joi.object()
        .pattern(Joi.string(), Joi.string())
        .default(Loggers.defaultMetaKeys)
        .description(`Which keys to copy from 'both' to meta with the option to rename the keys`),

      // Redaction
      redact: Joi.object()
        .pattern(
          Joi.string(),
          Joi.object({
            allowLevel: offDefaultLevelEnum,
            tags: Joi.array().items(Joi.string()),
          }).default({})
        )
        .default({}),

      // Errors
      maxErrors: Joi.number()
        .integer()
        .min(1)
        .default(25)
        .description('Errors reference other errors. This is the maximum number of errors to log.'),
      maxErrorDepth: Joi.number().integer().min(1).default(5).description(
        `Errors reference other errors, creating a graph. This is the maximum error graph depth to \
traverse.`
      ),

      // Converting objects to strings
      maxArrayLength: Joi.number()
        .integer()
        .min(1)
        .default(10)
        .description('The maximum number of elements to process when converting an array to a string'),
      maxDepth: Joi.number()
        .integer()
        .min(1)
        .default(10)
        .description('The maximum depth to traverse when converting an object to a string'),

      // Turn console status messages on and off
      say: Joi.object({
        flushed: Joi.boolean().default(true),
        flushing: Joi.boolean().default(true),
        ready: Joi.boolean().default(true),
        stopping: Joi.boolean().default(true),
        stopped: Joi.boolean().default(true),
        openCloudWatch: Joi.boolean().default(true),
      }).default({}),

      // Transport configuration
      cloudWatch: cloudWatchObject,

      // Console settings
      console: Joi.object({
        colors: Joi.boolean().description('If true, outputs text with ANSI colors to the console').default(true),
        data: Joi.boolean().description('If true, sends data, error objects, stack traces, etc. to the console'),
      }).default({}),

      // File settings
      file: Joi.object({
        directories: Joi.array()
          .items(Joi.string())
          .default(['logs', '/tmp/logs'])
          .description('Use an empty array for read-only filesystems'),
        maxSize: Joi.string().default('20m'),
        maxAge: Joi.string().default('14d'),
      }).default({}),

      // Category configuration
      categories: Joi.object()
        .pattern(
          Joi.string(),
          Joi.object({
            tags: Joi.object().pattern(
              Joi.string(),
              Joi.alternatives(
                onOffDefaultLevelEnum,
                Joi.object({
                  allowLevel: offDefaultLevelEnum.description(`\
Enable the tag for log entries with severity levels equal to or greater than the provided value`),
                  level: defaultLevelEnum,
                  other: onOffDefaultLevelEnum.description('Which value to use for transports not listed'),
                  file: onOffDefaultLevelEnum,
                  console: onOffDefaultLevelEnum,
                  errorFile: onOffDefaultLevelEnum,
                  cloudWatch: onOffDefaultLevelEnum,
                })
              )
            ),
            file: onOffDefaultLevelEnum,
            console: onOffDefaultLevelEnum,
            errorFile: onOffDefaultLevelEnum,
            cloudWatch: Joi.alternatives(cloudWatchCategoryObject, onOffDefaultLevelEnum),
          })
        )
        .default({}),

      // Testing
      unitTest: Joi.boolean(),
    }).label('Loggers options');
    // ==== Joi model for options (end)

    let validation = optionsSchema.validate(options);
    if (validation.error) throw new Error(validation.error.message);
    // Add defaults to default empty objects
    validation = optionsSchema.validate(validation.value);
    options = validation.value;

    this.options = options;
    return options;
  }

  /**
   * @description Starts the logger after the constructor or stop() is called
   */
  start() {
    if (!this.props.stopped) return;
    if (this.props.starting) throw new Error('Starting');

    this.props.starting = true;

    const { options } = this;

    if (options.unitTest) {
      // eslint-disable-next-line no-console
      console.log(`${banner}Unit test mode enabled`);

      this.unitTest = {
        entries: [],
        logGroupIds: {},
        dataCount: 0,
      };

      transportNames.forEach((transport) => {
        this.unitTest[transport] = { entries: [] };
      });
    }

    this.props.stopped = false;

    // Create one logger for uncaught exceptions and unhandled Promise rejections. Winston transports have some magic to
    // catch uncaught exceptions.
    // process.on('uncaughtException') is dangerous and doesn't work for exceptions thrown in a function called by the
    // event loop -- e.g., setTimeout(() => {throw...})
    const unhandledLoggers = this.logger(logCategories.unhandled);
    // Create a Winston logger now to catch uncaught exceptions
    if (unhandledLoggers.isLevelEnabled('error')) {
      this.props.unhandledPromiseListener = (error) => {
        unhandledLoggers.error('Unhandled Promise rejection', { error });
      };
      process.on('unhandledRejection', this.props.unhandledPromiseListener);
    }

    this.props.starting = false;

    if (options.say.ready) {
      const { service, stage, version } = options;
      this.log(null, `Ready: ${service} v${version} ${stage}`, null, logCategories.log);
    }
  }

  /**
   * @private
   * @ignore
   * @description Internal function called by methods that are named after levels. Allows tags to be provided.
   * @param {Loggers|Logger} obj
   * @param {Object} levelObj From this.props.logLevel. Has property logLevel.
   * @param {*} tagsOrMessage
   * @param {*} messageOrContext
   * @param {*} contextOrCategory
   * @param {*} category
   * @return {Object} Returns obj
   */
  static levelLog(obj, levelObj, tagsOrMessage, messageOrContext, contextOrCategory, category) {
    // tagsOrMessage has tags if it's an array
    if (messageOrContext !== undefined && tagsOrMessage instanceof Array) {
      const tags = Loggers.tags(levelObj, tagsOrMessage);
      return obj.log(tags, messageOrContext, contextOrCategory, category);
    }
    return obj.log(levelObj, tagsOrMessage, messageOrContext, contextOrCategory, category);
  }

  /**
   * @private
   * @ignore
   * @description Creates a directory for log files
   */
  createLogsDirectory() {
    if (this.props.logsDirectory !== undefined) return;

    this.props.logsDirectory = ''; // This method is only called once

    const { directories } = this.options.file;
    if (
      directories.length &&
      !directories.every((dir) => {
        try {
          mkdirp(dir);
          this.props.logsDirectory = dir;
          return false;
        } catch (error) {
          return true; // Next iteration
        }
      })
    ) {
      return;
    }

    // Unable to create directories - output warning to console
    // eslint-disable-next-line no-console
    console.error(`${banner}Creating logs directory failed. Directories attempted:
${directories.join('\n')}`);
  }

  /**
   * @private
   * @ignore
   * @description Checks whether the provided category value is a string or a falsey value
   * @param {*} category
   * @return {String} Returns the provided category if it is a truthy string; otherwise, returns the default category
   * @throws When this.options.unitTest is true, throws an exception if the category is not a string
   */
  checkCategory(category) {
    if (category) {
      const type = typeof category;
      if (type === 'string') return category;

      const message = `Invalid datatype for category argument (${type})`;
      const error = Error(message);

      // Send error message to console with the immediate caller (from the call stack) in the same line for easier
      // identification. Log the full stack to a file.
      this.log('error', error, null, logCategories.log);
      const stack = error.stack.replace(stripStack, '');
      // eslint-disable-next-line no-console
      console.error(`${banner}${message}${stack}`);
      // Throw exception when unit testing
      if (this.options.unitTest) throw error;
    }

    return this.options.defaultCategory;
  }

  /**
   * @private
   * @description Processes tag switches for one category specified in this.options
   * @param {String} category
   * @return {Boolean} true only if tag switches are defined for the category
   */
  processCategoryTags(category) {
    // this.options looks like:
    // categories: {
    //   foo: {
    //     tags: {
    //       sql: {
    //         file: 'on'
    let tags = this.options.categories[category];
    if (tags) ({ tags } = tags);
    if (!tags) return false;

    // This code is only called once per category so use of Object.entries is fine
    Object.entries(tags).forEach(([tag, tagInfo]) => {
      let categoryTags = this.props.categoryTags[category];
      if (!categoryTags) categoryTags = this.props.categoryTags[category] = {};

      if (typeof tagInfo === 'string') {
        categoryTags[tag] = { on: tagInfo };
      } else {
        categoryTags[tag] = tagInfo;
      }
    });

    return true;
  }

  /**
   * @private
   * @ignore
   * @description Determines whether a log entry can be sent to a transport
   * @param {String} transportName
   * @param {Object} info Log entry
   * @return {Object} Either returns logEntry unaltered or a falsey value
   */
  checkTags(transportName, info) {
    if (info.logTransports && !info.logTransports.includes(transportName)) return false;
    if (this.unitTest) this.unitTest[transportName].entries.push(info);
    return info;
  }

  /**
   * @private
   * @ignore
   * @description Returns default meta for log entries
   * @param {String} category
   * @return {Object}
   */
  static defaultMeta(category) {
    // Do not add more fields here. category is needed by the custom formatter for logging uncaught exceptions.
    return {
      category, // The category of the Winston logger, not the category
      // provided to log() etc.
    };
  }

  /**
   * @private
   * @ignore
   * @description Combines a custom Winston formatter with format.ms()
   * @return {Object} A Winston formatter
   */
  formatter() {
    return format.combine(winston.format((info) => this.format(info))(), format.ms());
  }

  /**
   * @private
   * @ignore
   * @description Winston customer formatter
   *  1. Enforces log() is called to support uncaught exception logging
   *  2. Manages this.unitTest object for unit test validation
   *  3. Adds 'ms' to log entries
   * @param {Object} info The log entry to format
   * @return {Object} info or false
   */
  format(info) {
    if (info instanceof LogEntry) {
      if (this.unitTest) {
        this.unitTest.entries.push(info);
        if (info.logGroupId) this.unitTest.logGroupIds[info.logGroupId] = true;
        if (info.data) ++this.unitTest.dataCount;
      }
      return info;
    }
    // ========================================================
    // This is the uncaught exception handler. Reroute to log()
    // ========================================================
    const { category } = info; // From defaultMeta
    delete info.category;
    let { level } = info;
    if (!level || typeof level !== 'string') {
      level = 'error';
    } else {
      delete info.level;
    }
    if (info.stack) {
      // Remove stack from logEntry.message
      const { message } = info;
      let index = message.indexOf('\n');
      if (index >= 0) {
        const index2 = message.indexOf('\r');
        if (index2 >= 0 && index2 < index) index = index2;
        info.message = message.substr(0, index);
      }
    }
    this.log(level, info, null, category);
    return false;
  }

  /**
   * @private
   * @ignore
   * @description Console formatter for 'no data'
   * @param {Object} info A log entry
   * @return {String}
   */
  static printf(info) {
    // info.level is colorized. To get the level, do this:
    // const shouldLogError = info.level.indexOf('error') >= 0;
    return `[${info.level} ${info.category} ${info.ms}] ${info.message}`;
  }

  /**
   * @private
   * @ignore
   * @description Creates a console transport
   * @param {String} level
   * @param {Boolean} handleExceptions
   * @return {Object} A new console transport
   */
  createConsoleTransport(level, handleExceptions) {
    const { colors } = this.options.console;

    if (this.options.console.data) {
      // Fancy console
      const consoleFormat = WinstonConsoleFormat({
        showMeta: true,
        inspectOptions: {
          depth: Infinity,
          colors,
          maxArrayLength: Infinity,
          breakLength: 120,
          compact: Infinity,
        },
      });

      const checkTags = winston.format((info) => this.checkTags('console', info))();

      return new winston.transports.Console({
        handleExceptions,
        level,
        format: colors
          ? format.combine(checkTags, format.colorize({ all: true }), consoleFormat)
          : format.combine(checkTags, consoleFormat),
      });
    }

    // Plain console
    const checkTags = winston.format((info) => {
      if (info.logDepth) return false;
      return this.checkTags('console', info);
    })();

    const printf = format.printf(Loggers.printf);

    return new winston.transports.Console({
      handleExceptions,
      level,
      format: colors
        ? format.combine(checkTags, format.colorize({ all: true }), printf)
        : format.combine(checkTags, printf),
    });
  }

  /**
   * @private
   * @ignore
   * @description Sets this.props.cloudWatch
   */
  initCloudWatch() {
    if (this.props.cloudWatch) return;

    this.props.cloudWatch = {};
    this.props.cloudWatch.transports = [];

    let stream = this.props.created.replace('T', ' ');
    // CloudWatch UI already sorts on time
    stream = `${stream} ${this.props.hostId}`;
    stream = stream.replace(/:/g, '');
    this.props.cloudWatch.streamName = stream;
  }

  /**
   * @private
   * @ignore
   * @description Creates Winston logger for CloudWatch errors that logs to the console and possibly to a file
   * @return {Object} logger
   */
  createCloudWatchErrorLoggers() {
    const transports = [];

    // Console
    transports.push(this.createConsoleTransport('error', false));

    // File
    this.createLogsDirectory();
    if (this.props.logsDirectory) {
      let filename = path.join(this.props.logsDirectory, `${logCategories.cloudWatch}-%DATE%`);
      const dir = path.dirname(filename);

      if (dir !== this.props.logsDirectory)
        try {
          mkdirp(dir);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`{$banner}Creating directory failed: ${dir}
${error}`);
          filename = null;
        }

      if (filename) {
        transports.push(
          new winston.transports.DailyRotateFile({
            filename,
            extension: '.log',
            datePattern: 'YYYY-MM-DD-HH',
            utc: true,
            zippedArchive: true,
            maxSize: this.options.file.maxSize,
            maxFiles: this.options.file.maxAge,
            format: format.json(),
            level: 'error',
            handleExceptions: false,
          })
        );
      }
    }

    return winston.createLogger({
      defaultMeta: Loggers.defaultMeta(logCategories.cloudWatch),
      exitOnError: false,
      format: this.formatter(),
      levels: this.props.levelSeverity,
      transports,
    });
  }

  /**
   * @private
   * @ignore
   * @description Handles errors from the CloudWatch transport
   * @param {Object} error
   */
  cloudWatchError(error) {
    if (error.code === 'ThrottlingException') return;
    if (error.code === 'DataAlreadyAcceptedException') return;
    // TODO: Submit feature request. See cwTransportShortCircuit
    // InvalidParameterException is thrown when the formatter provided to
    // winston-cloudwatch returns false
    if (error.code === 'InvalidParameterException') return;
    this.log('error', error, null, logCategories.cloudWatch);
  }

  /**
   * @private
   * @ignore
   * @description Flushes a CloudWatch transport. See https://github.com/lazywithclass/winston-cloudwatch/issues/128.
   * @param {Object} transport
   * @param {Number} timeout
   * @return {Promise}
   */
  flushCloudWatchTransport(transport, timeout) {
    // TODO: Fix this when WinstonCloudWatch makes flush timeout an option
    // https://github.com/lazywithclass/winston-cloudwatch/issues/129
    // This ends up taking way too long if, say, the aws-sdk is not properly configured. Submit issue to
    // winston-cloudwatch.
    transport.flushTimeout = Date.now() + timeout;
    return new Promise((resolve) => {
      transport.kthxbye((error) => {
        if (error) this.cloudWatchError(error);
        resolve();
      });
    });
  }

  /**
   * @description Flushes Cloudwatch transports
   * @return {Promise}
   */
  async flushCloudWatchTransports() {
    if (!this.props.cloudWatch) return;

    const { flushTimeout } = this.options.cloudWatch;

    let flushMessageTask;
    let flushMessageSent;

    if (this.options.say.flushing) {
      // Output a message if flush takes longer than 2.5 seconds
      flushMessageTask = setTimeout(() => {
        const duration = humanizeDuration(flushTimeout);
        flushMessageSent = true;
        // eslint-disable-next-line no-console
        console.log(`${banner}Waiting up to ${duration} to flush AWS CloudWatch Logs`);
      }, 2500);
    }

    await Promise.all(
      this.props.cloudWatch.transports.map((transport) => this.flushCloudWatchTransport(transport, flushTimeout))
    );

    // For testing the message
    // await new Promise( (resolve) => setTimeout(resolve, 10000));

    if (flushMessageTask) clearTimeout(flushMessageTask);

    if (flushMessageSent) {
      // eslint-disable-next-line no-console
      console.log(`${banner}Flushed AWS CloudWatch Logs`);
    }
  }

  /**
   * @description Flushes transports that suppot flushing. Currently only CloudWatch.
   * @return {Promise}
   */
  flush() {
    return this.flushCloudWatchTransports();
  }

  /**
   * @private
   * @ignore
   * @description Closes all loggers
   * @return {Promise}
   * @throws {None}
   */
  async close() {
    if (this.unitTest && !this.unitTest.flush) {
      // Test uncaught exception
      setTimeout(() => {
        throw new Error('Expected error: Uncaught exception while stopping');
      });
      await new Promise((resolve) => setTimeout(resolve, 1));

      // This unhandled Promise rejection is handled after this method finishes
      // by the default handler
      Promise.reject(new Error('Expected error: Rejected promise while stopping'));
    }

    await this.flushCloudWatchTransports();

    // Close
    await Promise.all(
      Object.entries(this.props.winstonLoggers).map(([category, logger]) => {
        if (!logger.writable || category === logCategories.cloudWatch) {
          return Promise.resolve();
        }
        return (
          new Promise((resolve, reject) => {
            logger
              .on('error', reject)
              .on('close', resolve)
              .on('finish', () => setImmediate(() => logger.close()))
              .end();
          })
            // eslint-disable-next-line no-console
            .catch((error) => console.error(`[${category}]`, error))
        );
      })
    );

    // Close the CloudWatch error logger last
    if (this.props.cloudWatch) {
      // Flush again because uncaught exceptions can be sent to CloudWatch transports during close
      // https://github.com/lazywithclass/winston-cloudwatch/issues/129
      await this.flushCloudWatchTransports();
      delete this.props.cloudWatch;

      if (this.unitTest) {
        const count = this.unitTest.entries.length;
        this.cloudWatchError(new Error('Testing CloudWatch error while stopping'));
        if (count === this.unitTest.entries.length) throw new Error('CloudWatch error handler failed');
      }
    }

    this.props.winstonLoggers = {};

    const errorLogger = this.props.winstonLoggers[logCategories.cloudWatch];
    this.props.loggers = {};

    if (errorLogger && errorLogger.writable) {
      // eslint-disable-next-line no-constant-condition
      if (true) {
        errorLogger.close();
      } else {
        // For testing
        // TODO: finish doesn't fire and this terminates the process
        // The only downside is the CloudWatch error log might not get flushed
        await new Promise((resolve, reject) => {
          errorLogger
            .on('error', reject)
            .on('close', resolve)
            .on('finish', () => setImmediate(() => errorLogger.close()))
            .end();
          // eslint-disable-next-line no-console
        }).catch(console.error);
      }
    }

    if (this.unitTest) {
      // Test error handlers after closing loggers
      if (this.unitTest.flush) process.exit();

      setImmediate(() => {
        throw new Error('Expected error: Uncaught exception while stopping 2');
      });

      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    if (this.props.unhandledPromiseListener) {
      process.removeListener('unhandledRejection', this.props.unhandledPromiseListener);
      delete this.props.unhandledPromiseListener;
    }

    this.props.stopping = false;
    this.props.stopped = true;

    if (this.options.say.stopped) {
      const { service, stage, version } = this.options;
      // eslint-disable-next-line no-console
      console.log(`${banner}Stopped: ${service} v${version} ${stage}`);
    }
  }

  /**
   * @description Flushes loggers and stops them
   * @return {Promise}
   * @throws {None}
   */
  async stop() {
    if (this.props.stopped) return;

    if (this.props.stopping) {
      // Stop is already running. Wait for it to finish.
      await new Promise((resolve) => {
        if (this.props.stopWaiters) {
          this.props.stopWaiters.push(resolve);
        } else {
          this.props.stopWaiters = [resolve];
          if (this.unitTest) this.unitTest.hasStopWaiters = true;
        }
      });

      return;
    }

    if (this.options.say.stopping) {
      const { service, stage, version } = this.options;
      this.log(null, `Stopping: ${service} v${version} ${stage}`, null, logCategories.log);
    }

    this.props.stopping = true;

    if (this.unitTest) {
      this.stop().then(() => {
        if (!this.unitTest.hasStopWaiters) throw new Error('Waiting while stopping failed');
      });
    }

    await this.close();

    if (this.props.stopWaiters) {
      this.props.stopWaiters.forEach((resolve) => resolve());
      delete this.props.stopWaiters;
    }
  }

  /**
   * @private
   * @ignore
   * @description Creates a Winston logger
   * @param {String} category
   * @return {Object} Winston logger
   */
  createWinstonLoggers(category) {
    if (this.props.stopped) throw new Error('Stopped');

    let logger;

    if (category === logCategories.cloudWatch) {
      logger = this.createCloudWatchErrorLoggers();
    } else {
      if (this.props.stopping) throw new Error('Stopping');

      const { categories } = this.options;
      let settings = categories[category];

      {
        const defaults = categories.default;
        if (settings) {
          settings = { ...defaults, ...settings };
        } else {
          settings = defaults;
        }
      }

      if (!settings) settings = {};

      const transports = [];
      let level;

      // ====
      // File
      level = settings.file || 'off';
      if (level === 'default') {
        level = this.options.defaultLevel;
      } else if (level === 'on') {
        level = 'info';
      }

      if (level !== 'off') {
        this.createLogsDirectory();

        if (this.props.logsDirectory) {
          let filename = path.join(this.props.logsDirectory, `${category}-%DATE%`);
          const dir = path.dirname(filename);

          if (dir !== this.props.logsDirectory)
            try {
              mkdirp(dir);
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(`{$banner}Creating directory failed: ${dir}
${error}`);
              filename = null;
            }

          if (filename) {
            const checkTags = winston.format((info) => this.checkTags('file', info))();
            const transport = new winston.transports.DailyRotateFile({
              filename,
              extension: '.log',
              datePattern: 'YYYY-MM-DD-HH',
              utc: true,
              zippedArchive: true,
              maxSize: this.options.file.maxSize,
              maxFiles: this.options.file.maxAge,
              format: format.combine(checkTags, format.json()),
              level,
              handleExceptions: category === logCategories.unhandled,
            });

            transports.push(transport);
          }
        }
      }

      // ==========
      // CloudWatch
      let awsOptions = { ...this.options.cloudWatch };
      level = settings.cloudWatch || 'off';

      if (typeof level === 'object') {
        Object.assign(awsOptions, level);
        level = awsOptions.level || 'off';
      }

      if (level === 'default') {
        level = this.options.defaultLevel;
      } else if (level === 'on') {
        level = 'warn';
      }

      if (level !== 'off') {
        let { logGroup: logGroupName } = awsOptions;
        if (!awsOptions.region) {
          awsOptions.region = process.env.AWS_CLOUDWATCH_LOGS_REGION;
          if (!awsOptions.region) {
            awsOptions.region = process.env.AWS_CLOUDWATCH_REGION;
            if (!awsOptions.region) awsOptions.region = process.env.AWS_DEFAULT_REGION;
          }
        }

        if (!awsOptions.region) {
          // eslint-disable-next-line no-console
          console.error(`[${category}] Region was not specified for AWS CloudWatch Logs`);
        } else if (!logGroupName) {
          // eslint-disable-next-line no-console
          console.error(`[${category}] Log group was not specified for AWS CloudWatch Logs`);
        } else {
          this.initCloudWatch();
          const { uploadRate } = awsOptions;

          // log group ends with a slash
          logGroupName = `${logGroupName.replace(/[/]+$/, '').replace(/[/][/]+$/g, '')}/`;

          if (this.options.say.openCloudWatch) {
            if (category === logCategories.log) {
              // eslint-disable-next-line no-console
              console.log(`[${category}] Opening AWS CloudWatch Logs stream \
${awsOptions.region}:${logGroupName}:${this.props.cloudWatch.streamName} at level '${level}'`);
            } else {
              this.log(
                'info',
                `Opening AWS CloudWatch Logs stream \
${awsOptions.region}:${logGroupName}:${this.props.cloudWatch.streamName} \
at level '${level}' for category '${category}'`,
                {
                  category,
                  logGroup: logGroupName,
                  logStream: this.props.cloudWatch.streamName,
                  level,
                  awsRegion: awsOptions.region,
                  uploadRate,
                },
                logCategories.log
              );
            }
          }

          awsOptions = { region: awsOptions.region };

          const checkTags = (info) => {
            // TODO: Submit feature request. See cwTransportShortCircuit
            if (!this.checkTags('cloudWatch', info)) return '';
            return JSON.stringify(info);
          };

          // TODO: add more options supported by winston-cloudwatch
          const transport = new WinstonCloudWatch({
            messageFormatter: checkTags,
            logStreamName: this.props.cloudWatch.streamName,
            createLogGroup: true,
            createLogStream: true,
            logGroupName,
            awsOptions,
            level,
            errorHandler: (error) => this.cloudWatchError(error),
            uploadRate,
            handleExceptions: category === logCategories.unhandled,
          });

          this.props.cloudWatch.transports.push(transport);
          transports.push(transport);
        }
      }

      // =======
      // Console
      level = settings.console || 'info';
      if (level === 'default') {
        level = this.options.defaultLevel;
      } else if (level === 'on') {
        level = 'info';
      }

      // Winston wants at least one transport (error file transport is intentionally ignored because it's only error) so
      // console is always active
      if (!transports.length && level === 'off') level = 'error';

      if (level !== 'off') transports.push(this.createConsoleTransport(level, category === logCategories.unhandled));

      // Error file
      level = settings.errorFile || 'off';
      if (level === 'default') {
        level = this.options.defaultLevel;
      } else if (level === 'on') {
        level = 'error';
      }

      if (level !== 'off') {
        this.createLogsDirectory();
        if (this.props.logsDirectory) {
          const checkTags = winston.format((info) => this.checkTags('errorFile', info))();
          const transport = new winston.transports.DailyRotateFile({
            filename: `${this.props.logsDirectory}/${category}-error-%DATE%`,
            extension: '.log',
            datePattern: 'YYYY-MM-DD-HH',
            zippedArchive: true,
            maxSize: this.options.file.maxSize,
            maxFiles: this.options.file.maxAge,
            format: format.combine(checkTags, format.json()),
            level,
            handleExceptions: category === logCategories.unhandled,
          });

          transports.push(transport);
        }
      }

      logger = winston.createLogger({
        defaultMeta: Loggers.defaultMeta(category),
        exitOnError: false,
        format: this.formatter(),
        levels: this.winstonLevels,
        transports,
      });
    }

    this.props.winstonLoggers[category] = logger;
    return logger;
  }

  /**
   * @description Returns a Winston logger associated with a category
   * @param {String} [category]
   * @return {Object} A Winston logger
   */
  winstonLogger(category) {
    if (this.props.stopped) throw new Error('Stopped');

    category = this.checkCategory(category);
    let logger = this.props.winstonLoggers[category];
    if (!logger) logger = this.createWinstonLoggers(category);

    return logger;
  }

  /**
   * @private
   * @ignore
   * @description Accessor for the options provided for a category
   * @param {String} [category]
   * @return {Object} An object or undefined
   */
  categoryOptions(category) {
    category = this.checkCategory(category);
    return this.options.categories[category];
  }

  /**
   * @description Returns a logger associated with a category
   * @param {String} [category]
   * @return {Loggers|Logger}
   */
  logger(category) {
    category = this.checkCategory(category);
    let logger = this.props.loggers[category];
    if (logger) return logger;
    // Initialize the category
    this.processCategoryTags(category);
    // eslint-disable-next-line no-use-before-define
    logger = new Logger(this, undefined, undefined, category);
    this.props.loggers[category] = logger;
    return logger;
  }

  /**
   * @description Creates a child logger
   * @param {*} [tags]
   * @param {*} [context]
   * @param {String} [category]
   * @return {Logger}
   */
  child(tags, context, category) {
    const logger = this.logger(category);
    if (!tags && !context) return logger;
    // eslint-disable-next-line no-use-before-define
    return new Logger(logger, tags, context);
  }

  /**
   * @description Indicates whether this object and its child loggers are ready to log messages
   * @return {Boolean} Returns false if messages can not be logged because the logger is stopping or has been stopped
   */
  isReady() {
    return !this.props.starting && !this.props.stopped && !this.props.stopping;
  }

  /**
   * @description Determines whether a log entry will be sent to a logger
   * @param {*} [tags]
   * @param {String} [category]
   * @return {Object} If the message will be logged, returns an object with keys
   *     tags, logger, level, transports, and
   *  category. Otherwise, returns false.
   */
  isLevelEnabled(tags, category) {
    if (this.props.stopped) {
      // eslint-disable-next-line no-console
      console.error(`${banner} ${new Error('Stopped').stack}`);
      return false;
    }

    tags = Loggers.tags(tags);
    let tagNames;

    let level;

    if (tags) {
      // Use logLevel meta tag
      const value = tags.logLevel;
      if (value !== undefined) {
        if (this.props.logLevel[value]) {
          level = value === 'default' ? this.options.defaultLevel : value;
          tags[level] = true;
        }
        delete tags.logLevel;
      }

      tagNames = Object.keys(tags);

      if (!level) {
        // Populate level such that, for example, 'error' overrides 'debug' if both are present
        let levelNum = 100000;

        tagNames.forEach((tag) => {
          if (tags[tag] && this.props.logLevel[tag]) {
            const num = this.props.levelSeverity[tag];
            if (num < levelNum) {
              levelNum = num;
              level = tag === 'default' ? this.options.defaultLevel : tag;
            }
          }
        });
      }
    }

    if (!level) level = this.options.defaultLevel;

    category = this.checkCategory(category);

    // Process the category's settings for tag filtering
    {
      const logger = this.props.loggers[category];
      if (!logger) this.logger(category);
    }

    let logTransports;

    if (tagNames) {
      // Look for a blocked tag
      // TODO: Defaults should be specified at the category level
      // TODO: Cache results for tags for the category that aren't yet defined in config
      const categoryTags = this.props.categoryTags[category];
      const defaultTags = this.props.categoryTags.default;
      let nextLevel = level;

      if (
        !tagNames.every((tag) => {
          // Return true to continue
          if (this.props.levelSeverity[tag] !== undefined) return true; // It's a level tag

          let categoryTransports;
          if (categoryTags) categoryTransports = categoryTags[tag];

          let checkDefault = true;

          // Check allowLevel
          if (categoryTransports) {
            const { allowLevel } = categoryTransports;
            if (allowLevel) {
              if (this.props.levelSeverity[level] <= this.props.levelSeverity[allowLevel]) return true;
              checkDefault = false;
            }
          }

          const defaultTransports = defaultTags[tag];

          if (checkDefault) {
            if (defaultTransports) {
              const { allowLevel } = defaultTransports;
              if (allowLevel) {
                // TODO: cache this
                if (this.props.levelSeverity[level] <= this.props.levelSeverity[allowLevel]) return true;
              } else if (
                this.props.levelSeverity[level] <= this.props.levelSeverity[this.options.defaultTagAllowLevel]
              ) {
                // Defaults to warn (severity 1)
                // TODO: Cache this
                return true;
              }
            } else if (this.props.levelSeverity[level] <= this.props.levelSeverity[this.options.defaultTagAllowLevel]) {
              // Defaults to warn (severity 1)
              // TODO: Cache this
              return true;
            }
          }

          // The .on key specifies whether the (category, tag) pair is enabled
          // and is computed only once
          if (categoryTransports) {
            const { on } = categoryTransports;
            if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) return false;
          } else {
            if (!defaultTransports) return true;
            const { on } = defaultTransports;
            if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) return false;
          }

          // Alter level?
          if (categoryTransports) {
            let { level: lvl } = categoryTransports;
            if (lvl) {
              if (lvl === 'default') lvl = this.options.defaultLevel;
              if (this.props.levelSeverity[lvl] < this.props.levelSeverity[nextLevel]) {
                // TODO: Exit early if isLevelEnabled(lvl) is false
                nextLevel = lvl;
              }
            }
          }

          // Process per-transport switches. Remove keys from logTransports.
          transportNames.forEach((transport) => {
            if (logTransports && !logTransports[transport]) return true;

            checkDefault = true;

            if (categoryTransports) {
              let on = categoryTransports[transport];
              if (on) {
                checkDefault = false;
                if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) {
                  if (!logTransports) logTransports = { ...transportObj };
                  delete logTransports[transport];
                }
              } else {
                on = categoryTransports.other;
                if (on) {
                  checkDefault = false;
                  if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) {
                    if (!logTransports) logTransports = { ...transportObj };
                    delete logTransports[transport];
                  }
                }
              }
            }

            if (checkDefault && defaultTransports) {
              let on = defaultTransports[transport];
              if (on) {
                if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) {
                  if (!logTransports) logTransports = { ...transportObj };
                  delete logTransports[transport];
                }
              } else {
                on = defaultTransports.other;
                if (on) {
                  if (this.props.levelSeverity[level] > this.props.levelSeverity[on]) {
                    if (!logTransports) logTransports = { ...transportObj };
                    delete logTransports[transport];
                  }
                }
              }
            }

            return true;
          });

          return !logTransports || Loggers.hasKeys(logTransports);
        })
      ) {
        return false;
      }

      // Turn logTransports from an object to an array of keys
      if (logTransports) logTransports = Object.keys(logTransports);

      // Change the level based on tag settings
      if (nextLevel) level = nextLevel;
    }

    let logger = this.props.winstonLoggers[category];
    if (!logger) logger = this.winstonLogger(category);
    if (!logger.isLevelEnabled(level)) return false;

    return {
      category,
      level,
      logger,
      tags,
      logTransports,
    };
  }

  /**
   * @private
   * @ignore
   * @description Converts an object to a string
   * @param {*} value It must be truthy
   * @return {String} or a falsy value
   */
  objectToString(value) {
    if (value instanceof Array) {
      value = JSON.parse(prune(value, this.options.maxDepth, this.options.maxArrayLength));
      return util.inspect(value);
    }

    // Allow the object to speak for itself
    let msg = value.toString();
    if (msg !== '[object Object]') return msg;

    msg = value.message;

    if (msg) {
      msg = msg.toString(); // Avoid recursion
      if (msg === '[object Object]') return false;
      return msg;
    }

    return false;
  }

  /**
   * @private
   * @ignore
   * @description Does nothing if the provided key is redacted. Helper function to combine 'message' and 'context'.
   * Handles overlapping keys in both. Sets state.currentData to state.data or state.contextData and then sets
   * state.currentData[key] to value.
   * @param {String} level
   * @param {Object} tags
   * @param {String} state An object with keys data, contextData, and currentData
   * @param {Object} state An object with keys data, contextData, and currentData
   * @param {String} key
   * @param {*} value Value to store in the property named 'key'
   */
  copyData(level, tags, state, key, value) {
    const redact = this.options.redact[key];
    if (redact) {
      let shouldRedact = true;

      const { tags: redactTags } = redact;
      // Redact only if a tag matches
      if (redactTags && redactTags.length) shouldRedact = !redactTags.every((tag) => !tags[tag]);

      if (shouldRedact) {
        // Check the level override
        const { allowLevel } = redact;
        if (!allowLevel) return; // Defaults to always redact
        if (this.props.levelSeverity[allowLevel] > this.props.levelSeverity[level]) return;
      }
    }

    if (!state.currentData) {
      state.currentData = state.data = {};
    } else if (state.currentData === state.data && key in state.data && value !== state.data[key]) {
      // message and context overlap; their values differ
      if (!value) return;
      state.currentData = state.contextData = {};
    }

    state.currentData[key] = value;
  }

  /**
   * @private
   * @ignore
   * @description Creates a log entry
   * @param {Object} info A value returned by isLevelEnabled()
   * @param {*} message
   * @param {*} context
   * @param {Number} depth When falsey, create the 'root' log entry. When truthy, create a secondary entry that is in
   * the same group as the root log entry.
   * 1. When the level is in this.props.logStackLevels, the stack is added when falsey
   * 2. The logStack and noLogStack meta tags are applied when falsey
   * @return {Object} A log entry
   */
  logEntry(info, message, context, depth) {
    const entry = new LogEntry();
    const { level } = info;

    // undefined values are placeholders for ordering and are deleted at the end
    // of this method
    Object.assign(entry, {
      message: undefined,
      level,
      timestamp: Loggers.now(),
      ms: false, // Set via a formatter; intentionally not removed
      tags: false,
      ...this.props.userMeta,
      category: info.category, // Overwritten by defaultMeta
      logGroupId: false, // Set and removed by send()
      logDepth: 0, // Set and removed by send()
      stage: this.options.stage,
      hostId: this.props.hostId,
      service: this.options.service,
      version: this.options.version,
      commitSha: undefined,
      stack: false, // Set and removed by send()
      data: undefined,
      logTransports: info.logTransports,
    });

    // Points to data first and contextData if there are the same keys in message and context
    const state = {};
    const { tags } = info;

    context = Loggers.contextToObject(context);

    // Combine message and context
    [message, context].forEach((item) => {
      if (!item) return;

      const type = typeof item;
      if (type === 'function') return;

      if (type === 'object') {
        if (item instanceof Array) {
          this.copyData(level, tags, state, 'message', this.objectToString(item));
        } else {
          // Object.keys is not used in order to get inherited properties
          // eslint-disable-next-line guard-for-in, no-restricted-syntax
          for (const key in item) {
            const value = item[key];
            // Despite being non-enumerable, if these properties are added explicitly, they will be found via 'in'
            if (typeof value !== 'function' && key !== 'stack' && key !== 'message') {
              // stack and message are handled below
              this.copyData(level, tags, state, key, value);
            }
          }

          const { stack } = item;
          if (stack && typeof stack === 'string') this.copyData(level, tags, state, 'stack', stack);

          // If the object has a conversion to string, use it. Otherwise, use its message property if it's a scalar
          const msg = this.objectToString(item);

          if (msg) this.copyData(level, tags, state, 'message', msg);
        }
      } else {
        // It's truthy and it's not an object
        this.copyData(level, tags, state, 'message', item.toString());
      }
    });

    // Promote data to meta
    const { data } = state;
    if (data) {
      this.props.metaKeys.forEach((key) => {
        const value = data[key];
        if (value !== null && value !== undefined) {
          const type = typeof value;
          key = this.props.meta[key]; // Rename object key to meta key
          if (type === 'string') {
            if (value.length) {
              entry[key] = value;
            }
          } else if (scalars[type]) {
            entry[key] = value;
          }
        }

        if (key === 'message') delete data[key];
      });

      if (Loggers.hasKeys(data)) entry.data = data;
    }

    // Transports don't like empty messages
    if (entry.message === null || entry.message === undefined) entry.message = '';

    // Remove meta keys that have undefined values
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const key in entry) {
      const value = entry[key];
      if (value === undefined) delete entry[key];
    }

    if (state.contextData) entry.contextData = state.contextData;

    // Add stack trace?
    let addStack = !depth && this.props.logStackLevels[info.level];

    // Turn tags into an array and put the level in the front without modifying
    // the object in entry.tags
    if (tags) {
      // Make sure meta tags are deleted

      let value = tags.noLogStack;

      if (value !== undefined) {
        if (!depth) addStack = !value;
        delete tags.noLogStack;
      }

      value = tags.logStack;
      if (value !== undefined) {
        if (!depth) addStack = value;
        delete tags.logStack;
      }

      // Move the level to the front of the tags array
      const tags2 = Object.keys(tags).filter((tag) => tags[tag] && tag !== level);
      entry.tags = [level, ...tags2];
    } else {
      entry.tags = [level];
    }

    // Set the stack meta
    if (addStack) entry.stack = new Error(entry.message).stack.replace('Error: ', '').replace(stripStack, '');

    return entry;
  }

  /**
   * @private
   * @ignore
   * @description Sends log entries to a Winston logger
   * @param {Object} info A value returned by isLevelEnabled()
   * @param {*} [message]
   * @param {*} [context]
   * @param {Error[]} [errors] Errors already logged, to avoid recursion
   * @param {Number} [depth] Recursion depth (defaults to 0)
   * @param {String} [logGroupId]
   */
  send(info, message, context, errors, depth = 0, logGroupId) {
    const { category, logger, level } = info;

    const entry = this.logEntry(info, message, context, depth);

    let contextMessages;
    let contextCopied;

    const addContext = depth < this.options.maxErrorDepth;

    if (message instanceof Error) {
      if (!errors) {
        errors = [message];
      } else if (!errors.includes(message)) {
        errors.push(message);
      }
    }

    let { contextData } = entry;
    if (contextData) {
      delete entry.contextData;
      if (!addContext) {
        contextData = undefined; // Avoid infinite recursion
      } else {
        // contextData might have errors from context - remove them so overlap doesn't happen again
        // eslint-disable-next-line guard-for-in, no-restricted-syntax
        for (const key in contextData) {
          const value = contextData[key];
          if (value instanceof Error) {
            if (!errors) {
              errors = [value];
            } else if (!errors.includes(value)) {
              errors.push(value);
            }
          }
        }
      }
    }

    const { data } = entry;
    if (data) {
      if (addContext) {
        // ==========================
        // Add Errors to errors array
        // eslint-disable-next-line guard-for-in, no-restricted-syntax
        for (const key in data) {
          const value = data[key];

          // eslint-disable-next-line no-continue
          if (!(value instanceof Error)) continue;

          let addIt = true;

          // Check for circular references
          if (!errors) {
            errors = [value];
          } else if (errors.length < this.options.maxErrors && !errors.includes(value)) {
            errors.push(value);
          } else {
            addIt = false;
          }

          if (addIt) {
            if (!contextMessages) contextMessages = [value];
            else contextMessages.push(value);
          }

          if (context && key in context) {
            // Otherwise it will reappear in the next call to log()
            if (!contextCopied) {
              context = { ...context };
              contextCopied = true;
            }
            delete context[key];
          }

          // Error->string
          data[key] = this.objectToString(value);
        }
      }

      // The default message is data.error if it exists
      if (!entry.message && scalars[typeof data.error]) entry.message = data.error;
      // TODO: This is dropping undefined values
      entry.data = JSON.parse(prune(data, this.options.maxDepth, this.options.maxArrayLength));
    }

    // Remove falsey values from entry that were set to false by logEntry()
    if (!entry.stack) delete entry.stack;

    // Set logGroupId meta
    if ((contextData || contextMessages) && !logGroupId) logGroupId = uuidv1();
    if (logGroupId) {
      entry.logGroupId = logGroupId;
    } else {
      delete entry.logGroupId;
    }

    // Set logDepth meta
    if (depth) {
      entry.logDepth = depth;
    } else {
      delete entry.logDepth;
    }

    // Only CloudWatch's error logger can be used while stopping
    if (this.props.stopping && category !== logCategories.cloudWatch) {
      // eslint-disable-next-line no-console
      console.error(`[${category}] Stopping. Unable to log:
${util.inspect(entry)}
${new Error('Stopping').stack}`);
      return;
    }

    logger.log(level, entry);

    if (contextData) this.send(info, contextData, undefined, errors, depth + 1, logGroupId);

    if (contextMessages)
      contextMessages.forEach((contextMessage) => {
        this.send(info, contextMessage, context, errors, depth + 1, logGroupId);
      });
  }

  /**
   * @private
   * @ignore
   * @description Tranforms arugments sent to the log method
   * @param {*} [tags] See description.
   * @param {*} [message]
   * @param {*} [context]
   * @param {String} [category]
   * @return {Object} false or an argument containing new values for tags, message, context, and category
   */
  transformLogArguments(tags, message, context, category) {
    let transformed;

    // console.log({ tags, message, context, category });

    // First argument is an Error object?
    if (tags instanceof Error) {
      transformed = true;
      if (!message) {
        message = tags;
      } else {
        context = Loggers.context(context, tags);
      }
      tags = this.props.logLevel.error;
    } else if (message instanceof Error) {
      if (!tags) {
        tags = this.props.logLevel.error;
        transformed = true;
      }
    } else if (
      tags &&
      !message &&
      typeof tags === 'object' &&
      !(tags instanceof Array) &&
      (tags.tags || tags.message || tags.context || tags.category)
    ) {
      transformed = true;
      message = tags;
      let messageCopied;
      const { message: hasMessage } = message;
      if (message.tags) {
        if (!hasMessage) {
          message = { ...message };
          messageCopied = true;
        }
        tags = message.tags;
        if (!hasMessage) delete message.tags;
      } else {
        tags = undefined;
      }
      if (message.context /* && typeof message.context === 'object' */) {
        if (!hasMessage && !messageCopied) {
          message = { ...message };
          messageCopied = true;
        }
        context = Loggers.context(context, message.context);
        if (!hasMessage) delete message.context;
      }
      if (message.category && typeof message.category === 'string') {
        if (!hasMessage && !messageCopied) {
          message = { ...message };
          messageCopied = true;
        }
        category = message.category;
        if (!hasMessage) delete message.category;
      }
      message = hasMessage;
      // if (hasMessage && Object.keys(message).length === 1) message = hasMessage;
    } else if (
      message &&
      typeof message === 'object' &&
      !(message instanceof Array) &&
      (message.tags || message.message || message.context) /* typeof(message.context) === 'object' */
    ) {
      transformed = true;
      let messageCopied;
      const { message: hasMessage } = message;
      if (message.tags) {
        if (!hasMessage) {
          message = { ...message };
          messageCopied = true;
        }
        tags = Loggers.tags(tags, message.tags);
        if (!hasMessage) delete message.tags;
      }
      if (message.context /* && typeof message.context === 'object' */) {
        if (!hasMessage && !messageCopied) {
          message = { ...message };
          messageCopied = true;
        }
        context = Loggers.context(context, message.context);
        if (!hasMessage) delete message.context;
      }
      // message = hasMessage;
      if (hasMessage && Object.keys(message).length === 1) message = hasMessage;
    }

    if (!transformed) return false;

    return {
      tags,
      message,
      context,
      category,
    };
  }

  /**
   * @description Sends a log entry using the default level
   * @return {Loggers} this
   */
  default(...args) {
    return Loggers.levelLog(this, this.props.logLevel.default, ...args);
  }

  /**
   * @description Sends a log entry.
   * If tags is an Error object, error is used for tags and message is set as follows:
   *   1. If message is falsey, message = tags
   *   2. Otherwise, context = Loggers.context(context, {error: tags})
   * If tags is an object and has truthy values for tags, level, message, or context, the keys in tags are used as
   * follows if they are truthy:
   *   1. tags = Loggers.tags(tags.level, tags.tags)
   *   2. message = tags.message
   *   3. context = tags.context
   *   4. category = tags.category
   * @param {*} [tags] See description
   * @param {*} [message]
   * @param {*} [context]
   * @param {String} [category]
   * @return {Object} this
   */
  log(tags, message, context, category) {
    const args = this.transformLogArguments(tags, message, context, category);
    if (args) {
      ({ tags, message, context, category } = args);
    }

    if (this.props.stopped) {
      // eslint-disable-next-line no-console
      console.error(`[${category}] Stopped. Unable to log:
${util.inspect({
  category,
  tags,
  message,
  context,
})}
${new Error('Stopped').stack}`);
    } else {
      const info = this.isLevelEnabled(tags, category);
      if (info) this.send(info, message, context);
    }

    return this;
  }
}

/**
 * @description Default meta keys. Values are either undefined or a string containing the actual meta key name. For
 *  example, given the tuple a: 'b', both.a is copied to meta.b. The 'both' object is not altered; its keys are also
 *  copied to data. For convenience, the existence of the tuple a: 'b' implies the existence of the tuple b: 'b'.
 */
Loggers.defaultMetaKeys = {};

/**
 * @description These follow npm levels wich are defined at
 * https://github.com/winstonjs/winston#user-content-logging-levels with the addition of 'fail' which is more severe
 * than 'error' and 'more' which is between 'info' and 'verbose.' A different set of levels can be provided to the
 * Loggers class's constructor; however, the Loggers class assumes there is an 'error' level and the options model (via
 * the defaults) assumes the following levels exist: error, warn, debug.
 */
Loggers.defaultLevels = {
  levels: {
    fail: 10,
    error: 20,
    warn: 30,
    info: 40,
    more: 50,
    verbose: 60,
    db: 70,
    http: 80,
    debug: 90,
    silly: 100,
  },
  colors: {
    fail: 'red',
    more: 'cyan',
    db: 'yellow',
  },
};

/**
 * @description This class manages a (tags, context, category) tuple. Its methods accept tags, context, and category,
 *  which, if provided, are combined with the object's corresponding properties. For example, if the object is created
 *  with tags = ['apple'] log('banana') will use the tags 'apple' and 'banana.' This class has level-specific logging
 *  methods such as error().
 *
 * Public Properties:
 *  {Object} tags
 *  {Object} context
 *  {String} category
 */
class Logger {
  /**
   * Private Properties
   *  {Object} loggersObj
   *  {Object} parentObj
   */
  /**
   * @constructor
   * @param {Loggers|Logger} logger
   * @param {*} [tags]
   * @param {*} [context]
   * @param {String} [category]
   */
  constructor(logger, tags, context, category) {
    if (logger instanceof Logger) {
      tags = Loggers.tags(logger.tags, tags);
      context = Loggers.context(logger.context, context);
      if (!category) category = logger.category;
      this.loggersObj = logger.loggersObj;
      this.parentObj = logger;
    } else {
      if (!(logger instanceof Loggers)) {
        throw new Error('logger must be an instance of Loggers or Logger');
      }
      this.loggersObj = this.parentObj = logger;
    }

    Object.assign(this, {
      tags,
      context,
      category,
    });

    // Dynamic logging-level methods
    this.loggersObj.addLevelMethods(this);
  }

  /**
   * @description Returns a Winston logger associated with a category
   * @param {String} [category]
   * @return {Object} A Winston logger
   */
  winstonLogger(category) {
    return this.loggersObj.winstonLogger(category || this.category);
  }

  /**
   * @return {Loggers}
   */
  loggers() {
    return this.loggersObj;
  }

  /**
   * @return {Loggers|Logger}
   */
  parent() {
    return this.parentObj;
  }

  /**
   * @return {Promise}
   */
  stop() {
    return this.loggersObj.stop();
  }

  /**
   * @return {Promise}
   */
  flushCloudWatchTransports() {
    return this.loggersObj.flushCloudWatchTransports();
  }

  /**
   * @return {Promise}
   */
  flush() {
    return this.loggersObj.flush();
  }

  /**
   * @param {String} [category]
   * @return {Loggers|Logger}
   */
  logger(category) {
    return new Logger(this, this.tags, this.context, category || this.category);
  }

  /**
   * @param {*} [tags]
   * @param {*} [context]
   * @param {String} [category]
   * @return {Logger}
   */
  child(tags, context, category) {
    return new Logger(this, tags, context, category || this.category);
  }

  /**
   * @param {*} [tags]
   * @param {String} [category]
   * @return {Boolean}
   */
  isLevelEnabled(tags, category) {
    return this.loggersObj.isLevelEnabled(this.tags ? Loggers.tags(this.tags, tags) : tags, category || this.category);
  }

  /**
   * @param {*} [tags]
   * @param {*} [message]
   * @param {*} [context]
   * @param {String} [category]
   * @return {Object}
   */
  log(tags, message, context, category) {
    const args = this.loggersObj.transformLogArguments(tags, message, context, category);
    if (args) {
      ({ tags, message, context, category } = args);
    }

    if (this.tags) tags = Loggers.tags(this.tags, tags);
    if (!category) category = this.category;

    const info = this.loggersObj.isLevelEnabled(tags, category);
    if (info) {
      // The objective of the above code is to avoid calling Loggers.context if the level is too low
      if (this.context) context = Loggers.context(this.context, context);
      this.loggersObj.send(info, message, context);
    }

    return this;
  }
}

module.exports = Loggers;
