export THEOS_PACKAGE_SCHEME = rootless

TARGET := iphone:clang:latest:15.0
ARCHS := arm64

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = AzotaQuizTutor
AzotaQuizTutor_FILES = Tweak.xm
AzotaQuizTutor_FRAMEWORKS = UIKit WebKit Foundation Security
AzotaQuizTutor_CFLAGS = -fobjc-arc -Wno-deprecated-declarations
AzotaQuizTutor_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

BUNDLE_NAME = AzotaQuizTutorResources
AzotaQuizTutorResources_FILES = ResourcesBundle.m
AzotaQuizTutorResources_FRAMEWORKS = Foundation
AzotaQuizTutorResources_RESOURCE_DIRS = Resources
AzotaQuizTutorResources_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

include $(THEOS_MAKE_PATH)/tweak.mk
include $(THEOS_MAKE_PATH)/bundle.mk
