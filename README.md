# Overview

This repository contains a proof-of-concept to facilate large file uploads primarily to a a WebRTC receiver.

* HTML5 + JS: "input multiple" element and all ZIP creation is done in pure JS

* Stream behavior - no intermediate storage or intrinsic file size cap on file(s) uploads

* Basic WebRTC flow control implemented so that browser heap doesn't grow too large 

Caveats:

* The demo WebRTC receiver where a "save as" dialog is presented is _not_ supported in Safari.

* WebRTC APIS used might be best supported in Chrome.  Firefox/Safari might have varying levels of support.

* Currently no CRC-32 in generated ZIP
