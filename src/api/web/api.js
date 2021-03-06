'use strict';

const bodyParser = require('body-parser');
const express = require('express');
const marked = require('marked');
const Search = require('../../lib/search');
const Middleware = require('./middleware');
const match = Middleware.match;
const validateName = Middleware.validate_name;
const validatePkg = Middleware.validate_package;
const securityIframe = Middleware.securityIframe;
const route = express.Router(); // eslint-disable-line
const async = require('async');
const HTTPError = require('http-errors');
const Utils = require('../../lib/utils');

/*
 This file include all verdaccio only API(Web UI), for npm API please see ../endpoint/
*/

module.exports = function(config, auth, storage) {
  Search.configureStorage(storage);
  const can = Middleware.allow(auth);

  // validate all of these params as a package name
  // this might be too harsh, so ask if it causes trouble
  route.param('package', validatePkg);
  route.param('filename', validateName);
  route.param('version', validateName);
  route.param('anything', match(/.*/));

  route.use(bodyParser.urlencoded({extended: false}));
  route.use(auth.jwtMiddleware());
  route.use(securityIframe);

  // Get list of all visible package
  route.get('/packages', function(req, res, next) {
    storage.get_local(function(err, packages) {
      if (err) {
        // that function shouldn't produce any
        throw err;
      }

      async.filterSeries(
        packages,
        function(pkg, cb) {
          auth.allow_access(pkg.name, req.remote_user, function(err, allowed) {
            if (err) {
              cb(null, false);
            } else {
              cb(err, allowed);
            }
          });
        },
        function(err, packages) {
          if (err) throw err;

          packages.sort(function(a, b) {
            if (a.name < b.name) {
              return -1;
            } else {
              return 1;
            }
          });
          next(packages);
        }
      );
    });
  });

  // Get package readme
  route.get('/package/readme(/@:scope?)?/:package/:version?', can('access'), function(req, res, next) {
    let packageName = req.params.package;
    if (req.params.scope) {
      packageName = `@${req.params.scope}/${packageName}`;
    }
    storage.get_package(packageName, {req: req}, function(err, info) {
      if (err) {
        return next(err);
      }
      res.set('Content-Type', 'text/plain');
      next(marked(info.readme || 'ERROR: No README data found!'));
    });
  });

  // Search package
  route.get('/search/:anything', function(req, res, next) {
    const results = Search.query(req.params.anything);
    const packages = [];

    const getPackageInfo = function(i) {
      storage.get_package(results[i].ref, (err, entry) => {
        if (!err && entry) {
          auth.allow_access(entry.name, req.remote_user, function(err, allowed) {
            if (err || !allowed) {
              return;
            }

            packages.push(entry.versions[entry['dist-tags'].latest]);
          });
        }

        if (i >= results.length - 1) {
          next(packages);
        } else {
          getPackageInfo(i + 1);
        }
      });
    };

    if (results.length) {
      getPackageInfo(0);
    } else {
      next([]);
    }
  });

  route.post('/login', function(req, res, next) {
    auth.authenticate(req.body.username, req.body.password, (err, user) => {
      if (!err) {
        req.remote_user = user;

        next({
          token: auth.issue_token(user, '24h'),
          username: req.remote_user.name,
        });
      } else {
        next(HTTPError[err.message ? 401 : 500](err.message));
      }
    });
  });

  route.post('/-/logout', function(req, res, next) {
    let base = Utils.combineBaseUrl(Utils.getWebProtocol(req), req.get('host'), config.url_prefix);
    res.cookies.set('token', '');
    res.redirect(base);
  });

  // What are you looking for? logout? client side will remove token when user click logout,
  // or it will auto expire after 24 hours.
  // This token is different with the token send to npm client.
  // We will/may replace current token with JWT in next major release, and it will not expire at all(configurable).

  return route;
};
