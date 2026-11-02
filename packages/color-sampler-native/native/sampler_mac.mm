// AGPL-3.0. NSColorSampler/sRGB conversion follows OrcaSlicer PR #16587.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <utility>
#include "sampler.h"

namespace screen_color {
namespace {
struct Selection { Callback done; bool cancelled = false; };
std::shared_ptr<Selection> current;
}
bool Available() { return NSClassFromString(@"NSColorSampler") != Nil; }
void Start(Callback done) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (current || !Available()) { done({Status::Failed}); return; }
        auto selection = std::make_shared<Selection>();
        selection->done = done;
        current = selection;
        NSColorSampler* sampler = [[NSColorSampler alloc] init];
        [sampler showSamplerWithSelectionHandler:^(NSColor* picked) {
            NSColor* srgb = picked ? [picked colorUsingColorSpace:[NSColorSpace sRGBColorSpace]] : nil;
            Result result{selection->cancelled || !picked ? Status::Cancelled : Status::Failed};
            if (srgb && !selection->cancelled) {
                const auto byte = [](CGFloat value) { return static_cast<std::uint32_t>(std::lround(std::clamp<double>(value, 0., 1.) * 255.)); };
                result = {Status::Picked, (byte(srgb.redComponent) << 16) | (byte(srgb.greenComponent) << 8) | byte(srgb.blueComponent)};
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                [sampler release];
                if (current == selection) current.reset();
                auto callback = std::move(selection->done);
                if (callback) callback(result);
            });
        }];
    });
}
void Cancel() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!current) return;
        // AppKit exposes no public dismiss method. Invalidate the result while
        // retaining the sampler until its system UI invokes the handler.
        current->cancelled = true;
        auto callback = std::move(current->done);
        if (callback) callback({Status::Cancelled});
    });
}
}
