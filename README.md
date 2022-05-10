# Overview

This repository contains a proof-of-concept to facilate large file uploads primarily to a a WebRTC receiver.

* HTML5 + JS: "input multiple" element and all ZIP creation is done in pure JS

* Stream behavior - no intermediate storage or intrinsic file size cap on file(s) uploads

* Basic WebRTC flow control implemented so that browser heap doesn't grow too large 

Caveats:

* The demo WebRTC receiver where a "save as" dialog is presented is _not_ supported in Safari.

* WebRTC APIS used might be best supported in Chrome.  Firefox/Safari might have varying levels of support.

* Currently no CRC-32 in generated ZIP

# Goal

The primary goal of this demonstration is to:

* allow multiple files/directories to be uploaded

* preserve directory hierarchies

* allow very large total payloads (10gb+) to be uploaded without error or crashing the browser


# Design

The basic structure of this demo is:

* a simple HTML5 form with a single "file" input to allow selection of a source directory to ZIP

* for each selected file, generate a ZIP on-the-fly in "chunks"

* interleave the process of transmission with ZIP structure


# Data Flow

For demo purposes, we'll round trip file data to/from the browser's disk.

Directory on Local Disk -> "local" RTC data channel -> "remote" RTC data channel -> Single File on Local Disk

For production purposes, the "remote" sides of this flow will be a server-side RTC peer.
