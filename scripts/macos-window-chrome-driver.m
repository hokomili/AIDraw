#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

static void Fail(NSString *message) {
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(2);
}

static long long ParseInteger(const char *text, NSString *label, long long minimum, long long maximum) {
  if (text == NULL || text[0] == '\0') Fail([NSString stringWithFormat:@"Missing %@.", label]);
  char *end = NULL;
  errno = 0;
  long long value = strtoll(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < minimum || value > maximum) {
    Fail([NSString stringWithFormat:@"Invalid %@.", label]);
  }
  return value;
}

static double ParseNumber(const char *text, NSString *label) {
  if (text == NULL || text[0] == '\0') Fail([NSString stringWithFormat:@"Missing %@.", label]);
  char *end = NULL;
  errno = 0;
  double value = strtod(text, &end);
  if (errno != 0 || end == text || *end != '\0' || !isfinite(value) || fabs(value) > 32768.0) {
    Fail([NSString stringWithFormat:@"Invalid %@.", label]);
  }
  return value;
}

static NSDictionary *BoundsRecord(CGRect bounds) {
  return @{
    @"x": @(bounds.origin.x),
    @"y": @(bounds.origin.y),
    @"width": @(bounds.size.width),
    @"height": @(bounds.size.height),
  };
}

static NSArray<NSDictionary *> *WindowsForPid(pid_t pid) {
  CFArrayRef copied = CGWindowListCopyWindowInfo(
    kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (copied == NULL) Fail(@"The Quartz window server returned no window list.");
  NSArray *windowInfo = CFBridgingRelease(copied);
  NSMutableArray<NSDictionary *> *matches = [NSMutableArray array];
  for (NSDictionary *entry in windowInfo) {
    NSNumber *owner = entry[(__bridge id)kCGWindowOwnerPID];
    NSNumber *layer = entry[(__bridge id)kCGWindowLayer];
    NSNumber *number = entry[(__bridge id)kCGWindowNumber];
    NSDictionary *boundsValue = entry[(__bridge id)kCGWindowBounds];
    if (owner.intValue != pid || layer.integerValue != 0 || number == nil || boundsValue == nil) continue;
    CGRect bounds = CGRectZero;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsValue, &bounds)
      || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)
      || bounds.size.width <= 0 || bounds.size.height <= 0) continue;
    // A regular AppKit application can own short off-screen menu-bar backing
    // surfaces at layer zero. They are not AIDraw editor windows. Keep this
    // driver bound to the product's generously larger editor/window contract.
    if (bounds.size.width < 320.0 || bounds.size.height < 240.0) continue;
    NSNumber *onScreen = entry[(__bridge id)kCGWindowIsOnscreen];
    [matches addObject:@{
      @"windowId": number,
      @"onScreen": @(onScreen.boolValue),
      @"bounds": BoundsRecord(bounds),
    }];
  }
  [matches sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"windowId"] compare:right[@"windowId"]];
  }];
  return matches;
}

static NSArray<NSDictionary *> *VisibleWindowsForPid(pid_t pid) {
  NSArray<NSDictionary *> *windows = WindowsForPid(pid);
  NSPredicate *visible = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *window, NSDictionary *bindings) {
    (void)bindings;
    return [window[@"onScreen"] boolValue];
  }];
  return [windows filteredArrayUsingPredicate:visible];
}

static NSDictionary *StandardButtonMetrics(void) {
  NSWindowStyleMask mask = NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
    | NSWindowStyleMaskResizable;
  NSWindow *probe = [[NSWindow alloc]
    initWithContentRect:NSMakeRect(0, 0, 480, 320)
    styleMask:mask
    backing:NSBackingStoreBuffered
    defer:YES];
  NSButton *close = [probe standardWindowButton:NSWindowCloseButton];
  NSButton *minimize = [probe standardWindowButton:NSWindowMiniaturizeButton];
  NSButton *zoom = [probe standardWindowButton:NSWindowZoomButton];
  if (close == nil || minimize == nil || zoom == nil) Fail(@"AppKit returned incomplete standard-window controls.");
  NSRect closeFrame = close.frame;
  NSRect minimizeFrame = minimize.frame;
  NSRect zoomFrame = zoom.frame;
  if (closeFrame.size.width <= 0 || closeFrame.size.height <= 0
    || NSMinX(minimizeFrame) <= NSMinX(closeFrame)
    || NSMinX(zoomFrame) <= NSMinX(minimizeFrame)) {
    Fail(@"AppKit returned invalid standard-window control geometry.");
  }
  return @{
    @"close": @{
      @"width": @(closeFrame.size.width),
      @"height": @(closeFrame.size.height),
    },
    @"minimize": @{
      @"offsetX": @(NSMinX(minimizeFrame) - NSMinX(closeFrame)),
      @"width": @(minimizeFrame.size.width),
      @"height": @(minimizeFrame.size.height),
    },
    @"zoom": @{
      @"offsetX": @(NSMinX(zoomFrame) - NSMinX(closeFrame)),
      @"width": @(zoomFrame.size.width),
      @"height": @(zoomFrame.size.height),
    },
  };
}

static void WriteJson(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (data == nil || error != nil) Fail(@"The macOS window driver could not serialize its bounded result.");
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static NSDictionary *ExactVisibleWindow(
  pid_t pid,
  CGWindowID expectedWindowId,
  CGRect expectedBounds
) {
  NSArray<NSDictionary *> *windows = WindowsForPid(pid);
  if (windows.count != 1) Fail(@"The exact owner does not have exactly one native editor window.");
  NSDictionary *window = windows.firstObject;
  if ([window[@"windowId"] unsignedIntValue] != expectedWindowId || ![window[@"onScreen"] boolValue]) {
    Fail(@"The exact owner/window identity is no longer visible.");
  }
  NSDictionary *boundsValue = window[@"bounds"];
  CGRect actual = CGRectMake(
    [boundsValue[@"x"] doubleValue],
    [boundsValue[@"y"] doubleValue],
    [boundsValue[@"width"] doubleValue],
    [boundsValue[@"height"] doubleValue]
  );
  const double tolerance = 2.0;
  if (fabs(actual.origin.x - expectedBounds.origin.x) > tolerance
    || fabs(actual.origin.y - expectedBounds.origin.y) > tolerance
    || fabs(actual.size.width - expectedBounds.size.width) > tolerance
    || fabs(actual.size.height - expectedBounds.size.height) > tolerance) {
    Fail([NSString stringWithFormat:
      @"The exact owner/window bounds changed before input admission: expected %.3f,%.3f %.3fx%.3f; actual %.3f,%.3f %.3fx%.3f.",
      expectedBounds.origin.x, expectedBounds.origin.y,
      expectedBounds.size.width, expectedBounds.size.height,
      actual.origin.x, actual.origin.y,
      actual.size.width, actual.size.height]);
  }
  return window;
}

static NSDictionary *ApplicationReadiness(pid_t pid) {
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (application == nil || application.processIdentifier != pid) {
    Fail(@"The exact owner PID is not one AppKit running application.");
  }
  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  pid_t frontmostPid = frontmost == nil ? -1 : frontmost.processIdentifier;
  BOOL ready = !application.terminated
    && application.finishedLaunching
    && application.activationPolicy == NSApplicationActivationPolicyRegular
    && application.active
    && frontmostPid == pid;
  return @{
    @"pid": @(pid),
    @"terminated": @(application.terminated),
    @"finishedLaunching": @(application.finishedLaunching),
    @"activationPolicy": @(application.activationPolicy),
    @"active": @(application.active),
    @"frontmostPid": @(frontmostPid),
    @"readyForInput": @(ready),
  };
}

static NSDictionary *RefreshedApplicationReadiness(pid_t pid) {
  // NSRunningApplication documents its time-varying properties as advancing on
  // a common-mode run-loop turn. Give this short-lived helper one bounded turn
  // before admitting frontmost state instead of trusting a cached observation.
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  return ApplicationReadiness(pid);
}

static NSDictionary *RequestExactApplicationActivation(pid_t pid) {
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (application == nil || application.processIdentifier != pid || application.terminated) {
    Fail(@"The exact owner PID is not one live AppKit running application.");
  }
  NSDictionary *before = RefreshedApplicationReadiness(pid);
  NSArray<NSDictionary *> *windowsBefore = WindowsForPid(pid);
  BOOL requestAccepted = [application activateWithOptions:0];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
  while (deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop]
      runMode:NSDefaultRunLoopMode
      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  return @{
    @"version": @1,
    @"pid": @(pid),
    @"requestAccepted": @(requestAccepted),
    @"before": before,
    @"after": ApplicationReadiness(pid),
    @"windowsBefore": windowsBefore,
    @"windowsAfter": WindowsForPid(pid),
  };
}

static NSDictionary *ActivateExactApplication(
  pid_t pid,
  CGWindowID windowId,
  CGRect expectedBounds
) {
  NSDictionary *windowBefore = ExactVisibleWindow(pid, windowId, expectedBounds);
  NSDictionary *before = RefreshedApplicationReadiness(pid);
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (application == nil || application.terminated
    || application.activationPolicy != NSApplicationActivationPolicyRegular) {
    Fail(@"The exact owner is not one activatable regular AppKit application.");
  }
  BOOL requested = ![before[@"readyForInput"] boolValue];
  BOOL requestAccepted = !requested || [application activateWithOptions:0];
  if (!requestAccepted) Fail(@"AppKit refused the exact owner's bounded activation request.");

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
  NSDictionary *after = ApplicationReadiness(pid);
  while (![after[@"readyForInput"] boolValue] && deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop]
      runMode:NSDefaultRunLoopMode
      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    after = ApplicationReadiness(pid);
  }
  if (![after[@"readyForInput"] boolValue]) {
    Fail(@"The exact owner did not become the frontmost ready application within 3000 ms.");
  }
  NSDictionary *windowAfter = ExactVisibleWindow(pid, windowId, expectedBounds);
  return @{
    @"version": @1,
    @"activated": @YES,
    @"activationRequested": @(requested),
    @"requestAccepted": @(requestAccepted),
    @"pid": @(pid),
    @"windowId": @(windowId),
    @"before": before,
    @"after": after,
    @"windowBefore": windowBefore,
    @"windowAfter": windowAfter,
  };
}

static NSDictionary *CloseExactApplicationWindow(
  pid_t pid,
  CGWindowID windowId,
  CGRect expectedBounds
) {
  if (!CGPreflightPostEventAccess()) Fail(@"CoreGraphics event-posting access is not pre-authorized; no prompt was requested.");
  NSDictionary *windowBefore = ExactVisibleWindow(pid, windowId, expectedBounds);
  NSDictionary *applicationReadiness = RefreshedApplicationReadiness(pid);
  if (![applicationReadiness[@"readyForInput"] boolValue]) {
    Fail(@"The exact owner is not frontmost and input-ready before its close accelerator.");
  }
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  if (source == NULL) Fail(@"CoreGraphics could not create the bounded close-accelerator event source.");
  // macOS virtual key code 118 is F4. AIDraw's native menu declares Alt+F4
  // as Close Editor Window on every supported desktop platform.
  CGEventRef keyDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)118, true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)118, false);
  if (keyDown == NULL || keyUp == NULL) {
    if (keyDown != NULL) CFRelease(keyDown);
    if (keyUp != NULL) CFRelease(keyUp);
    CFRelease(source);
    Fail(@"CoreGraphics could not create the bounded close-accelerator key events.");
  }
  CGEventSetFlags(keyDown, kCGEventFlagMaskAlternate);
  CGEventSetFlags(keyUp, kCGEventFlagMaskAlternate);
  CGEventPostToPid(pid, keyDown);
  [NSThread sleepForTimeInterval:0.06];
  CGEventPostToPid(pid, keyUp);
  CFRelease(keyDown);
  CFRelease(keyUp);
  CFRelease(source);
  [NSThread sleepForTimeInterval:0.25];
  return @{
    @"version": @1,
    @"action": @"close-window",
    @"posted": @YES,
    @"pid": @(pid),
    @"windowId": @(windowId),
    @"applicationReadiness": applicationReadiness,
    @"windowBefore": windowBefore,
    @"windowsAfter": WindowsForPid(pid),
  };
}

static void PostMouseEvent(
  pid_t pid,
  CGEventSourceRef source,
  CGEventType type,
  CGPoint point,
  CGEventFlags flags
) {
  CGEventRef event = CGEventCreateMouseEvent(source, type, point, kCGMouseButtonLeft);
  if (event == NULL) Fail(@"CoreGraphics could not create the bounded mouse event.");
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
  CGEventSetFlags(event, flags);
  CGEventPostToPid(pid, event);
  CFRelease(event);
}

static void ValidateLocalPoint(CGPoint point, CGRect bounds, NSString *label) {
  if (point.x < 0 || point.y < 0 || point.x >= bounds.size.width || point.y >= bounds.size.height) {
    Fail([NSString stringWithFormat:@"The %@ point is outside the exact window bounds.", label]);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) Fail(@"Usage: macos-window-chrome-driver preflight|inspect|inspect-visible|request-activation|activate|close-window|click|option-click|drag <exact arguments>.");
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    if ([command isEqualToString:@"preflight"]) {
      if (argc != 2) Fail(@"The preflight command accepts no owner or action arguments.");
      WriteJson(@{
        @"version": @1,
        @"postEventAccess": @(CGPreflightPostEventAccess()),
      });
      return 0;
    }
    if (argc < 3) Fail(@"The macOS window driver command requires one exact owner PID.");
    pid_t pid = (pid_t)ParseInteger(argv[2], @"owner PID", 1, INT_MAX);
    if ([command isEqualToString:@"inspect"]) {
      if (argc != 3) Fail(@"The inspect command accepts only one exact owner PID.");
      WriteJson(@{
        @"version": @1,
        @"pid": @(pid),
        @"postEventAccess": @(CGPreflightPostEventAccess()),
        @"applicationReadiness": RefreshedApplicationReadiness(pid),
        @"windows": WindowsForPid(pid),
        @"buttonMetrics": StandardButtonMetrics(),
      });
      return 0;
    }
    if ([command isEqualToString:@"inspect-visible"]) {
      if (argc != 3) Fail(@"The inspect-visible command accepts only one exact owner PID.");
      WriteJson(@{
        @"version": @1,
        @"pid": @(pid),
        @"postEventAccess": @(CGPreflightPostEventAccess()),
        @"applicationReadiness": RefreshedApplicationReadiness(pid),
        @"windows": VisibleWindowsForPid(pid),
        @"buttonMetrics": StandardButtonMetrics(),
      });
      return 0;
    }
    if ([command isEqualToString:@"request-activation"]) {
      if (argc != 3) Fail(@"The request-activation command accepts only one exact owner PID.");
      WriteJson(RequestExactApplicationActivation(pid));
      return 0;
    }

    if ([command isEqualToString:@"activate"]) {
      if (argc != 8) Fail(@"The activate command requires one exact owner/window/current-bounds shape.");
      if (!CGPreflightPostEventAccess()) Fail(@"CoreGraphics event-posting access is not pre-authorized; no prompt was requested.");
      CGWindowID windowId = (CGWindowID)ParseInteger(argv[3], @"window ID", 1, UINT_MAX);
      CGRect expectedBounds = CGRectMake(
        ParseNumber(argv[4], @"expected x"),
        ParseNumber(argv[5], @"expected y"),
        ParseNumber(argv[6], @"expected width"),
        ParseNumber(argv[7], @"expected height")
      );
      if (expectedBounds.size.width <= 0 || expectedBounds.size.height <= 0) Fail(@"The expected window bounds are empty.");
      WriteJson(ActivateExactApplication(pid, windowId, expectedBounds));
      return 0;
    }
    if ([command isEqualToString:@"close-window"]) {
      if (argc != 8) Fail(@"The close-window command requires one exact owner/window/current-bounds shape.");
      CGWindowID windowId = (CGWindowID)ParseInteger(argv[3], @"window ID", 1, UINT_MAX);
      CGRect expectedBounds = CGRectMake(
        ParseNumber(argv[4], @"expected x"),
        ParseNumber(argv[5], @"expected y"),
        ParseNumber(argv[6], @"expected width"),
        ParseNumber(argv[7], @"expected height")
      );
      if (expectedBounds.size.width <= 0 || expectedBounds.size.height <= 0) Fail(@"The expected window bounds are empty.");
      WriteJson(CloseExactApplicationWindow(pid, windowId, expectedBounds));
      return 0;
    }

    BOOL dragging = [command isEqualToString:@"drag"];
    BOOL optionClick = [command isEqualToString:@"option-click"];
    if (![command isEqualToString:@"click"] && !optionClick && !dragging) Fail(@"The macOS window driver command is not allowlisted.");
    if ((!dragging && argc != 10) || (dragging && argc != 12)) Fail(@"The macOS window driver received the wrong exact action shape.");
    if (!CGPreflightPostEventAccess()) Fail(@"CoreGraphics event-posting access is not pre-authorized; no prompt was requested.");

    CGWindowID windowId = (CGWindowID)ParseInteger(argv[3], @"window ID", 1, UINT_MAX);
    CGRect expectedBounds = CGRectMake(
      ParseNumber(argv[4], @"expected x"),
      ParseNumber(argv[5], @"expected y"),
      ParseNumber(argv[6], @"expected width"),
      ParseNumber(argv[7], @"expected height")
    );
    if (expectedBounds.size.width <= 0 || expectedBounds.size.height <= 0) Fail(@"The expected window bounds are empty.");
    NSDictionary *applicationReadiness = RefreshedApplicationReadiness(pid);
    if (![applicationReadiness[@"readyForInput"] boolValue]) {
      Fail(@"The exact owner is not frontmost and input-ready immediately before event posting.");
    }
    NSDictionary *window = ExactVisibleWindow(pid, windowId, expectedBounds);
    applicationReadiness = ApplicationReadiness(pid);
    if (![applicationReadiness[@"readyForInput"] boolValue]) {
      Fail(@"The exact owner lost frontmost readiness during window admission.");
    }
    NSDictionary *boundsValue = window[@"bounds"];
    CGRect currentBounds = CGRectMake(
      [boundsValue[@"x"] doubleValue],
      [boundsValue[@"y"] doubleValue],
      [boundsValue[@"width"] doubleValue],
      [boundsValue[@"height"] doubleValue]
    );
    CGPoint startLocal = CGPointMake(ParseNumber(argv[8], @"start x"), ParseNumber(argv[9], @"start y"));
    ValidateLocalPoint(startLocal, currentBounds, @"start");
    CGPoint start = CGPointMake(currentBounds.origin.x + startLocal.x, currentBounds.origin.y + startLocal.y);
    CGPoint end = start;
    if (dragging) {
      CGPoint endLocal = CGPointMake(ParseNumber(argv[10], @"end x"), ParseNumber(argv[11], @"end y"));
      ValidateLocalPoint(endLocal, currentBounds, @"end");
      end = CGPointMake(currentBounds.origin.x + endLocal.x, currentBounds.origin.y + endLocal.y);
    }

    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (source == NULL) Fail(@"CoreGraphics could not create a private bounded event source.");
    CGEventFlags flags = optionClick ? kCGEventFlagMaskAlternate : 0;
    PostMouseEvent(pid, source, kCGEventMouseMoved, start, flags);
    [NSThread sleepForTimeInterval:0.15];
    PostMouseEvent(pid, source, kCGEventLeftMouseDown, start, flags);
    if (dragging) {
      const int steps = 8;
      for (int step = 1; step <= steps; step += 1) {
        double progress = (double)step / (double)steps;
        CGPoint point = CGPointMake(
          start.x + ((end.x - start.x) * progress),
          start.y + ((end.y - start.y) * progress)
        );
        [NSThread sleepForTimeInterval:0.025];
        PostMouseEvent(pid, source, kCGEventLeftMouseDragged, point, flags);
      }
    } else {
      [NSThread sleepForTimeInterval:0.06];
    }
    PostMouseEvent(pid, source, kCGEventLeftMouseUp, end, flags);
    CFRelease(source);
    WriteJson(@{
      @"version": @1,
      @"action": dragging ? @"drag" : (optionClick ? @"option-click" : @"click"),
      @"posted": @YES,
      @"postCallCompleted": @YES,
      @"deliveryAcknowledged": @NO,
      @"pid": @(pid),
      @"windowId": @(windowId),
      @"applicationReadiness": applicationReadiness,
      @"nativeBounds": BoundsRecord(currentBounds),
    });
  }
  return 0;
}
